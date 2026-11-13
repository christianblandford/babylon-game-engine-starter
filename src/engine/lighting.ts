import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { HDRFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import type { AbstractMesh, Camera, Scene } from "@babylonjs/core";
import { HDRIrradianceFiltering } from "@babylonjs/core/Materials/Textures/Filtering/hdrIrradianceFiltering";
import { SkyMaterial } from "@babylonjs/materials/sky/skyMaterial";
import type { QualitySettings } from "../config";
import type { Lighting } from "./context";

/** Layer bit for meshes that exist only to be baked into the lighting probe. */
const PROBE_ONLY_LAYER = 0x10000000;
/** How bright a sunlit cloud is next to the sky around it (the sky is HDR; this is in its units). */
const CLOUD_BRIGHTNESS = 1.6;
/** How far from the probe the sun mask sits (inside the probe's sky dome). */
const SUN_MASK_DISTANCE = 380;

export interface LightingOptions {
  /** Unit vector pointing toward the sun. */
  sunDirection?: Vector3;
  /** Direct sunlight strength at noon. */
  sunIntensity?: number;
  /** Strength of the sky's ambient light and reflections. */
  environmentIntensity?: number;
  /** Brightness of the sky itself (a linear gain on the atmosphere model). */
  skyGain?: number;
  /** Colour the ground bounces back up into the ambient light. */
  groundBounce?: Color3;
  /** Distance haze. 0 turns it off. */
  fogDensity?: number;
  /** How much of the sky is cloud, 0 (clear) to 1 (overcast). Default 0.45: fair-weather cumulus. */
  cloudCover?: number;
}

/**
 * A cloud pattern that repeats seamlessly: white where cloud is, with its
 * alpha as the cloud's thickness and its colour shaded from bright rims to
 * greyer middles, as a sunlit cumulus layer looks from below.
 */
function cloudTexture(scene: Scene, cover: number): { glow: RawTexture; cover: RawTexture } {
  const size = 512;
  let state = 2024;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  // Fractal value noise on lattices that wrap, so the texture tiles.
  const octaves = [5, 10, 20, 40, 80, 160].map((cells) => ({ cells, lattice: Float32Array.from({ length: cells * cells }, random) }));
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      let weight = 1;
      let total = 0;
      for (const { cells, lattice } of octaves) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const at = (ix: number, iy: number): number => lattice[(iy % cells) * cells + (ix % cells)]!;
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
        value += (top + (bottom - top) * sy) * weight;
        total += weight;
        weight *= 0.52;
      }
      value /= total;
      // More cover lowers the bar a patch of noise must clear to become cloud.
      const bar = 0.72 - cover * 0.42;
      const thickness = Math.min(1, Math.max(0, (value - bar) / 0.16));
      const shade = 1 - 0.38 * thickness * thickness; // rims catch the sun; the middle is in its own shadow
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = Math.round(255 * shade);
      pixels[i + 2] = Math.round(255 * Math.min(1, shade + 0.03));
      pixels[i + 3] = Math.round(255 * thickness * (2 - thickness)); // soft edges, solid middles
    }
  }
  // The same picture twice: once as the cloud's brightness, whose `level` is
  // turned up and down with the sun, and once as its opacity, which must stay
  // as painted. One texture cannot do both: a level above 1 on an opacity
  // texture makes the cloud more than opaque, and what is behind it is then
  // *subtracted*. With the sun behind a cloud that put large negative light
  // into the ambient bake.
  const make = (): RawTexture => {
    const texture = RawTexture.CreateRGBATexture(pixels, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.hasAlpha = true;
    texture.anisotropicFilteringLevel = 8;
    return texture;
  };
  return { glow: make(), cover: make() };
}

/** Something that can render shadows for a mesh (the renderer). */
export interface ShadowCaster {
  addShadowCaster(mesh: AbstractMesh, includeDescendants?: boolean): void;
}

export interface SceneLighting extends Lighting {
  /**
   * Hands shadow casting to the renderer. The shadow maps belong to whichever
   * renderer is in use; game code keeps calling `lighting.addShadowCaster`.
   */
  castShadowsThrough(caster: ShadowCaster): void;
  readonly sky: SkyMaterial;
  /** Resolves once the first ambient-light bake has finished. */
  readonly ready: Promise<void>;
  sunIntensity: number;
  environmentIntensity: number;
}

/**
 * Builds the whole outdoor lighting rig from one input — the sun direction:
 *
 * - a procedural atmosphere (the visible sky),
 * - a directional sun light (its shadows are drawn by the renderer),
 * - image-based lighting baked *from that same sky*, so ambient light and
 *   reflections always match what you see. No HDR files needed.
 *
 * The sky is rendered in scene-referred HDR, so it expects the HDR
 * renderer (`renderer.ts`) to tone-map the final image.
 */
export function createLighting(
  scene: Scene,
  camera: Camera,
  quality: QualitySettings,
  options: LightingOptions = {},
): SceneLighting {
  const engine = scene.getEngine();
  const sunDirection = (options.sunDirection ?? new Vector3(-0.55, 0.62, -0.56)).normalizeToNew();
  // The sky lights everything in shade, so this is also the brightness of
  // shadows. Too low and shaded walls go to mud; a real clear sky gives about
  // a fifth of full sunlight.
  const skyGain = options.skyGain ?? 0.17;
  // What sunlit ground throws back up: about a quarter of the sunlight that
  // lands on it, which at this sun strength is far from negligible. It is the
  // light on the underside of eaves and half the light on a shaded wall.
  const groundBounce = options.groundBounce ?? new Color3(0.34, 0.32, 0.24);
  let sunIntensity = options.sunIntensity ?? 3.6;

  // --- Visible sky -----------------------------------------------------------
  const sky = new SkyMaterial("sky", scene);
  sky.backFaceCulling = false;
  sky.useSunPosition = true;
  sky.rawHdrOutput = true;
  sky.luminance = skyGain;
  sky.turbidity = 3;
  sky.rayleigh = 1.6;
  sky.mieCoefficient = 0.004;
  sky.mieDirectionalG = 0.82;

  const skyDome = MeshBuilder.CreateBox("skyDome", { size: 1000 }, scene);
  skyDome.material = sky;
  skyDome.infiniteDistance = true;
  skyDome.isPickable = false;
  skyDome.applyFog = false;
  skyDome.alwaysSelectAsActiveMesh = true;

  // --- Clouds ----------------------------------------------------------------
  // A flat layer overhead, like the base of a field of cumulus: it converges
  // on the horizon as a real one does, drifts on the wind, and fades out
  // toward its edge so it never shows a rim. It is drawn into the ambient
  // bake too, so water and windows reflect cloud as well as sky.
  const cloudCover = options.cloudCover ?? 0.45;
  let clouds: Mesh | null = null;
  let cloudMaterial: StandardMaterial | null = null;
  if (cloudCover > 0) {
    const HEIGHT = 110;
    const REACH = 490; // inside the sky box, so it is never clipped
    const TILE = 420; // metres of sky one repeat of the pattern covers
    const rings = [0, 0.45, 0.8, 1];
    const fades = [1, 1, 0.75, 0]; // opacity at each ring
    const SPOKES = 32;
    const positions: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    rings.forEach((ring, r) => {
      for (let s = 0; s < SPOKES; s++) {
        const angle = (s / SPOKES) * Math.PI * 2;
        const x = Math.cos(angle) * ring * REACH;
        const z = Math.sin(angle) * ring * REACH;
        positions.push(x, HEIGHT, z);
        uvs.push(x / TILE, z / TILE);
        colors.push(1, 1, 1, fades[r]!);
        if (r > 0) {
          const a = (r - 1) * SPOKES + s;
          const b = (r - 1) * SPOKES + ((s + 1) % SPOKES);
          const c = r * SPOKES + s;
          const d = r * SPOKES + ((s + 1) % SPOKES);
          indices.push(a, c, b, b, c, d);
        }
      }
    });
    clouds = new Mesh("clouds", scene);
    const data = new VertexData();
    data.positions = positions;
    data.uvs = uvs;
    data.colors = colors;
    data.indices = indices;
    data.applyToMesh(clouds);
    clouds.hasVertexAlpha = true;

    const pattern = cloudTexture(scene, cloudCover);
    cloudMaterial = new StandardMaterial("clouds", scene);
    cloudMaterial.disableLighting = true; // lit by its own brightness: see applySun
    cloudMaterial.emissiveTexture = pattern.glow;
    cloudMaterial.opacityTexture = pattern.cover;
    cloudMaterial.diffuseColor = Color3.Black();
    cloudMaterial.specularColor = Color3.Black();
    cloudMaterial.backFaceCulling = false;
    cloudMaterial.disableDepthWrite = true;
    clouds.material = cloudMaterial;
    clouds.infiniteDistance = true;
    clouds.isPickable = false;
    clouds.applyFog = false;
    clouds.alwaysSelectAsActiveMesh = true;
    clouds.layerMask = 0x0fffffff | PROBE_ONLY_LAYER; // in the game's view and in the ambient bake

    // Drifting on the wind. `animationsEnabled` is what the game clock turns off to pause.
    const drift = scene.onBeforeRenderObservable.add(() => {
      if (!scene.animationsEnabled) return;
      const dt = Math.min(scene.getEngine().getDeltaTime() / 1000, 0.05);
      pattern.cover.uOffset = pattern.glow.uOffset += dt * 0.004;
      pattern.cover.vOffset = pattern.glow.vOffset += dt * 0.0015;
    });
    clouds.onDisposeObservable.addOnce(() => {
      scene.onBeforeRenderObservable.remove(drift);
      pattern.glow.dispose();
      pattern.cover.dispose();
      cloudMaterial?.dispose();
    });
  }

  // --- Sun -------------------------------------------------------------------
  const sun = new DirectionalLight("sun", sunDirection.negate(), scene);

  // Shadow maps are created by the renderer (see `castShadowsThrough`).
  let shadowCaster: ShadowCaster | null = null;
  const waitingToCast: Array<[AbstractMesh, boolean]> = [];

  // --- Probe-only copies used to bake ambient light --------------------------
  const probeSky = new SkyMaterial("probeSky", scene);
  probeSky.backFaceCulling = false;
  probeSky.useSunPosition = true;
  probeSky.rawHdrOutput = true;
  probeSky.luminance = skyGain;
  probeSky.turbidity = sky.turbidity;
  probeSky.rayleigh = sky.rayleigh;
  probeSky.mieCoefficient = sky.mieCoefficient;
  probeSky.mieDirectionalG = sky.mieDirectionalG;

  const probeDome = MeshBuilder.CreateBox("probeSkyDome", { size: 900 }, scene);
  probeDome.material = probeSky;
  probeDome.layerMask = PROBE_ONLY_LAYER;
  probeDome.isPickable = false;
  probeDome.applyFog = false;

  const probeUnlit = (name: string): StandardMaterial => {
    const material = new StandardMaterial(name, scene);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    return material;
  };

  // Masks the sun's disc out of the bake. Direct sunlight already comes from
  // the directional light; leaving the disc in would count it twice and put
  // sparkly artefacts in rough reflections.
  const sunMask = MeshBuilder.CreateDisc("probeSunMask", { radius: SUN_MASK_DISTANCE * Math.tan(2.2 * (Math.PI / 180)) }, scene);
  sunMask.material = probeUnlit("probeSunMask");
  sunMask.layerMask = PROBE_ONLY_LAYER;
  sunMask.isPickable = false;
  sunMask.applyFog = false;

  // Stand-in for the ground, so light arriving from below is a dim bounce
  // rather than the bright horizon the atmosphere model would give.
  const probeGroundMaterial = probeUnlit("probeGround");
  const probeGround = MeshBuilder.CreateDisc("probeGround", { radius: 440, tessellation: 24 }, scene);
  probeGround.rotation.x = Math.PI / 2;
  probeGround.position.y = -0.5;
  probeGround.material = probeGroundMaterial;
  probeGround.layerMask = PROBE_ONLY_LAYER;
  probeGround.isPickable = false;
  probeGround.applyFog = false;

  // Above 1 on purpose. The bake holds the sky and a flat ground, but a wall
  // in shade is also lit by every sunlit wall and street around it, which
  // nothing here computes. Without the lift, the shaded side of a street is
  // near black next to the sunlit one.
  let environmentIntensity = options.environmentIntensity ?? 1.45;
  scene.environmentIntensity = environmentIntensity;

  if (options.fogDensity !== 0) {
    scene.fogMode = 2; // Scene.FOGMODE_EXP2
    scene.fogDensity = options.fogDensity ?? 0.0035;
  }

  // --- Everything that depends on where the sun is ---------------------------
  function applySun(): void {
    const elevation = Math.max(0, sunDirection.y); // 0 at the horizon, 1 overhead
    const warmth = 1 - Math.min(1, elevation / 0.45); // 1 at sunrise/sunset
    const daylight = Math.min(1, elevation / 0.12); // fades the sun out as it sets

    sun.direction.copyFrom(sunDirection).scaleInPlace(-1);
    sun.diffuse.set(1, 0.96 - 0.38 * warmth, 0.9 - 0.62 * warmth);
    sun.specular.copyFrom(sun.diffuse);
    sun.intensity = sunIntensity * daylight;

    const sunPosition = sunDirection.scale(400);
    sky.sunPosition = sunPosition;
    probeSky.sunPosition = sunPosition;
    sunMask.position.copyFrom(sunDirection).scaleInPlace(SUN_MASK_DISTANCE);
    sunMask.lookAt(Vector3.ZeroReadOnly);

    probeGroundMaterial.emissiveColor = groundBounce.scale(0.35 + 1.4 * elevation);
    // Clouds are lit by the sun: white at midday, warm and dimmer toward dusk.
    if (cloudMaterial?.emissiveTexture) cloudMaterial.emissiveTexture.level = CLOUD_BRIGHTNESS * (0.3 + 0.9 * elevation) * daylight;
    if (cloudMaterial) cloudMaterial.emissiveColor.set(0, 0, 0);
    scene.fogColor.set(0.62 - 0.1 * warmth, 0.7 - 0.2 * warmth, 0.8 - 0.32 * warmth).scaleInPlace(0.55 + 0.6 * elevation);
  }

  // --- Ambient light bake ----------------------------------------------------
  // Stands at the origin, where the bake's sky dome, sun mask and ground are
  // centred. Kept out of the scene's camera list: nothing else should find it.
  const bakeCamera = new FreeCamera("skyBakeCamera", Vector3.Zero(), scene, false);
  scene.removeCamera(bakeCamera);
  let activeProbe: ReflectionProbe | null = null;
  let bakeGeneration = 0;

  async function bake(): Promise<void> {
    const generation = ++bakeGeneration;
    const probe = new ReflectionProbe("skyProbe", quality.iblSize, scene, true, true, true);
    // Rendered once by hand below, so keep the scene from re-rendering it.
    scene.removeReflectionProbe(probe);
    probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    probe.renderList!.push(probeDome, sunMask, probeGround);
    if (clouds) probe.renderList!.push(clouds);
    const cube = probe.cubeTexture;

    try {
      await Promise.all([
        probeSky.forceCompilationAsync(probeDome),
        sunMask.material!.forceCompilationAsync(sunMask),
        probeGroundMaterial.forceCompilationAsync(probeGround),
      ]);
      // Shaders compile in the background, and the probe needs its own
      // variants. Rendering before they're ready would bake an empty sky.
      for (let waited = 0; !cube.isReadyForRendering() && waited < 300; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        if (scene.isDisposed) break;
      }
      if (scene.isDisposed) {
        probe.dispose();
        return;
      }
      // The probe needs an active camera (for its near and far planes), and
      // the Frame Graph renderer leaves none set between frames. It must be
      // one at the centre of the bake, not the game's: the sky model works
      // out where the sun is from the active camera's position, and seen
      // from wherever the player happens to stand the sun sits degrees away
      // from its mask. The unmasked disc then lands in the ambient light as
      // a blown-out, sparkling patch on any ground that mirrors the sun.
      bakeCamera.minZ = camera.minZ;
      bakeCamera.maxZ = camera.maxZ;
      const previousCamera = scene.activeCamera;
      scene.activeCamera = bakeCamera;
      cube.render();
      scene.activeCamera = previousCamera;
      // Tell the texture it has had its one render. Rendering it by hand does
      // not count, and once it becomes the scene's environment the scene
      // would draw it again as part of a normal frame: from the game camera,
      // and over the top of the filtering done below, replacing the proper
      // roughness chain with plain shrunken copies.
      cube._shouldRender();

      // Diffuse (irradiance) first: it reads the raw cube, which the specular
      // prefilter below replaces with its roughness mip chain.
      cube.irradianceTexture = await new HDRIrradianceFiltering(engine, { useCdf: false }).prefilter(cube);
      if (scene.isDisposed) return;
      await new HDRFiltering(engine).prefilter(cube);
    } catch (error) {
      probe.dispose();
      if (scene.isDisposed) return; // torn down mid-bake (a hot reload, a level change): nothing to report
      throw error;
    }

    if (scene.isDisposed || generation !== bakeGeneration) {
      probe.dispose(); // superseded by a newer bake
      return;
    }
    scene.environmentTexture = cube;
    activeProbe?.dispose();
    activeProbe = probe;
  }

  let rebakeTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleBake(): void {
    clearTimeout(rebakeTimer);
    rebakeTimer = setTimeout(() => void bake().catch(console.error), 120);
  }

  applySun();
  const ready = bake();

  scene.onDisposeObservable.addOnce(() => {
    clearTimeout(rebakeTimer);
    bakeGeneration++;
    bakeCamera.dispose();
  });

  return {
    sun,
    sunDirection,
    castShadowsThrough(caster) {
      shadowCaster = caster;
      for (const [mesh, includeDescendants] of waitingToCast.splice(0)) caster.addShadowCaster(mesh, includeDescendants);
    },
    sky,
    ready,
    get sunIntensity() {
      return sunIntensity;
    },
    set sunIntensity(value: number) {
      sunIntensity = value;
      applySun();
    },
    get environmentIntensity() {
      return environmentIntensity;
    },
    set environmentIntensity(value: number) {
      environmentIntensity = value;
      scene.environmentIntensity = value;
    },
    addShadowCaster(mesh: AbstractMesh, includeDescendants = true) {
      if (shadowCaster) shadowCaster.addShadowCaster(mesh, includeDescendants);
      else waitingToCast.push([mesh, includeDescendants]);
    },
    setSunDirection(direction: Vector3) {
      sunDirection.copyFrom(direction).normalize();
      applySun();
      scheduleBake();
    },
  };
}
