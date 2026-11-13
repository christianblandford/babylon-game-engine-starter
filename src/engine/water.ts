import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { BaseTexture, MaterialDefines, Mesh, Nullable, UniformBuffer } from "@babylonjs/core";
import type { GameContext } from "./context";

/**
 * Water: the sea, a moat, a pond, the surface of a well.
 *
 * It is Babylon's standard PBR material, set up as water: a dark, almost
 * mirror-smooth surface that reflects the sky and the sun, two layers of
 * ripples drifting across each other, and see-through when looked straight
 * down into but reflective at a glancing angle (which the material does by
 * itself: reflections are kept at full strength over the transparency).
 *
 * Being the same material as everything else, it is lit by the same sun, sky,
 * shadows and fog, costs one ordinary draw call, and works in both renderers
 * and on WebGPU.
 *
 * Babylon's `WaterMaterial` (materials library) is not used. It draws the
 * scene two more times each frame for its reflection and refraction, through
 * render targets that only the classic pipeline runs, so under the Frame
 * Graph they would never update; and it is not physically based, so it
 * doesn't match an HDR scene. What it does that this doesn't is mirror nearby
 * objects. If that is wanted, add screen-space reflections to the frame
 * graph rather than a second camera.
 *
 * To use it, hand `water.override` to the map loader under the name of the
 * Blender material it should replace:
 *
 *   const water = createWater(ctx);
 *   loadMap(ctx, url, { materials: { Water: water.override } });
 *
 * or put `water.material` on a mesh made in code and call
 * `water.prepareMesh(mesh)` once.
 */

export interface WaterOptions {
  /** The water's own colour: what you see looking down into the depths. */
  color?: Color3;
  /** How see-through it is looking straight down, 0 (opaque) to 1. */
  clarity?: number;
  /** Size of the larger ripples (m). */
  rippleSize?: number;
  /** How rough the surface is: 0 is glass, 1 is a choppy day. */
  rippleStrength?: number;
  /** How fast the ripples drift (m/s). */
  speed?: number;
}

export interface Water {
  readonly material: PBRMaterial;
  /** How see-through it is looking straight down, 0 to 1. */
  clarity: number;
  /** 0 is glass, 1 is choppy. */
  rippleStrength: number;
  /** Makes a mesh a body of this water: its ripples, and somewhere to swim. Call once per mesh. */
  prepareMesh(mesh: Mesh): void;
  /**
   * Height of the water's surface at a point on the map, or null where there
   * is none. This is what makes water more than a picture: the player floats
   * at this height.
   */
  surfaceAt(x: number, z: number): number | null;
  /**
   * Tells the water how deep it is everywhere, from the map's baked height
   * image (`heights` in the manifest; `height_map` in export_map.py). With
   * it, water thins to nothing at the waterline and is clearer and paler in
   * the shallows; without it, it meets the land in a hard line.
   */
  setHeights(heights: WaterHeights | null, baseUrl?: string): void;
  /** For `loadMap`'s `materials` option. */
  readonly override: { material: PBRMaterial; prepareMesh(mesh: Mesh): void };
  dispose(): void;
}

/** The map's baked terrain heights, as its manifest describes them. */
export interface WaterHeights {
  file: string;
  size: number;
  /** u = x * map[0] + map[2], v = z * map[1] + map[3]. */
  map: [number, number, number, number];
  /** Height in metres = low + value * range, where value is the image's 16-bit reading scaled to 0..1. */
  low: number;
  range: number;
}

/**
 * Depth-aware water. Reads the terrain's height under each pixel of water
 * from the map's height image and uses the difference from the surface:
 * nothing at the waterline, clear and pale over the shallows, the water's own
 * colour and opacity once it is deep.
 *
 * The image holds 16-bit heights split across two channels, which must not
 * be blended by the GPU's texture filter (half-way between two byte pairs is
 * not half-way between two heights), so it is read unfiltered at the four
 * surrounding pixels and blended here after decoding.
 */
class WaterDepthPlugin extends MaterialPluginBase {
  heights: { texture: BaseTexture; info: WaterHeights } | null = null;
  /** Depth (m) over which the water goes from clear to its full colour. */
  fade = 1.4;

  constructor(material: PBRMaterial) {
    super(material, "WaterDepth", 160, { WATERDEPTH: false }, true, true);
  }

  override getClassName(): string {
    return "WaterDepthPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  override isReadyForSubMesh(): boolean {
    return !this.heights || this.heights.texture.isReady();
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>).WATERDEPTH = this.heights !== null;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push("waterHeights");
  }

  override getActiveTextures(activeTextures: BaseTexture[]): void {
    if (this.heights) activeTextures.push(this.heights.texture);
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.heights?.texture;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [
        { name: "waterMap", size: 4, type: "vec4" },
        { name: "waterInfo", size: 4, type: "vec4" }, // image size, low, range, fade depth
      ],
      fragment: `uniform vec4 waterMap; uniform vec4 waterInfo;`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (!this.heights) return;
    const { texture, info } = this.heights;
    uniformBuffer.updateFloat4("waterMap", info.map[0], info.map[1], info.map[2], info.map[3]);
    uniformBuffer.updateFloat4("waterInfo", info.size, info.low, info.range, this.fade);
    uniformBuffer.setTexture("waterHeights", texture);
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
    if (shaderType !== "fragment") return null;
    return shaderLanguage === ShaderLanguage.WGSL ? DEPTH_WGSL : DEPTH_GLSL;
  }
}

const DEPTH_GLSL: Record<string, string> = {
  CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef WATERDEPTH
uniform sampler2D waterHeights;
float waterGround(vec2 pixel) {
    vec2 bytes = texture2D(waterHeights, (pixel + 0.5) / waterInfo.x).rg;
    return waterInfo.y + (bytes.r * 65280.0 + bytes.g * 255.0) / 65535.0 * waterInfo.z;
}
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#ifdef WATERDEPTH
{
    vec2 wdAt = (vPositionW.xz * waterMap.xy + waterMap.zw) * waterInfo.x - 0.5;
    vec2 wdCell = floor(wdAt);
    vec2 wdPart = wdAt - wdCell;
    float wdGround = mix(
        mix(waterGround(wdCell), waterGround(wdCell + vec2(1.0, 0.0)), wdPart.x),
        mix(waterGround(wdCell + vec2(0.0, 1.0)), waterGround(wdCell + vec2(1.0, 1.0)), wdPart.x),
        wdPart.y);
    float wdDepth = vPositionW.y - wdGround;
    float wdDeep = smoothstep(0.0, waterInfo.w, wdDepth);
    alpha *= smoothstep(0.0, 0.1, wdDepth) * mix(0.35, 1.0, wdDeep);
    surfaceAlbedo = mix(surfaceAlbedo * 2.2 + vec3(0.02, 0.035, 0.03), surfaceAlbedo, wdDeep);
}
#endif
`,
};

const DEPTH_WGSL: Record<string, string> = {
  CUSTOM_FRAGMENT_DEFINITIONS: `
#ifdef WATERDEPTH
var waterHeightsSampler: sampler;
var waterHeights: texture_2d<f32>;
fn waterGround(pixel: vec2f) -> f32 {
    let bytes: vec2f = textureSampleLevel(waterHeights, waterHeightsSampler, (pixel + vec2f(0.5)) / uniforms.waterInfo.x, 0.0).rg;
    return uniforms.waterInfo.y + (bytes.r * 65280.0 + bytes.g * 255.0) / 65535.0 * uniforms.waterInfo.z;
}
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALPHA: `
#ifdef WATERDEPTH
{
    let wdAt: vec2f = (fragmentInputs.vPositionW.xz * uniforms.waterMap.xy + uniforms.waterMap.zw) * uniforms.waterInfo.x - vec2f(0.5);
    let wdCell: vec2f = floor(wdAt);
    let wdPart: vec2f = wdAt - wdCell;
    let wdGround: f32 = mix(
        mix(waterGround(wdCell), waterGround(wdCell + vec2f(1.0, 0.0)), wdPart.x),
        mix(waterGround(wdCell + vec2f(0.0, 1.0)), waterGround(wdCell + vec2f(1.0, 1.0)), wdPart.x),
        wdPart.y);
    let wdDepth: f32 = fragmentInputs.vPositionW.y - wdGround;
    let wdDeep: f32 = smoothstep(0.0, uniforms.waterInfo.w, wdDepth);
    alpha = alpha * smoothstep(0.0, 0.1, wdDepth) * mix(0.35, 1.0, wdDeep);
    surfaceAlbedo = mix(surfaceAlbedo * 2.2 + vec3f(0.02, 0.035, 0.03), surfaceAlbedo, wdDeep);
}
#endif
`,
};

/** For anything that needs to know about all the water in a level, whatever kind: the highest surface at a point. */
export function waterSurface(...waters: Water[]): (position: { x: number; z: number }) => number | null {
  return ({ x, z }) => {
    let highest: number | null = null;
    for (const water of waters) {
      const level = water.surfaceAt(x, z);
      if (level !== null && (highest === null || level > highest)) highest = level;
    }
    return highest;
  };
}

/** One mesh of water, as flat triangles seen from above. */
interface Surface {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Corner coordinates, six numbers (x, z of each corner) per triangle. */
  triangles: Float32Array;
  level: number;
}

function insideTriangle(x: number, z: number, t: Float32Array, i: number): boolean {
  const ax = t[i]!, az = t[i + 1]!, bx = t[i + 2]!, bz = t[i + 3]!, cx = t[i + 4]!, cz = t[i + 5]!;
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

const TEXTURE_SIZE = 256;

/**
 * A ripple pattern that repeats seamlessly: a sum of sine waves that each fit
 * the tile a whole number of times. Returns the surface's slope at every
 * pixel, as (x, y) pairs in -1..1.
 */
function rippleSlopes(seed: number, waves: number): Float32Array {
  let state = seed;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0; // a small fixed generator, so the water looks the same every run
    return state / 0xffffffff;
  };
  const parts: { kx: number; ky: number; phase: number; height: number }[] = [];
  for (let i = 0; i < waves; i++) {
    const frequency = 2 + Math.floor(random() * 12);
    const angle = random() * Math.PI * 2;
    const kx = Math.round(Math.cos(angle) * frequency);
    const ky = Math.round(Math.sin(angle) * frequency);
    if (kx === 0 && ky === 0) continue;
    parts.push({ kx, ky, phase: random() * Math.PI * 2, height: 1 / Math.hypot(kx, ky) ** 1.2 });
  }
  const slopes = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE * 2);
  let steepest = 0;
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      let dx = 0;
      let dy = 0;
      for (const { kx, ky, phase, height } of parts) {
        const slope = Math.cos(((kx * x + ky * y) / TEXTURE_SIZE) * Math.PI * 2 + phase) * height;
        dx += slope * kx;
        dy += slope * ky;
      }
      const index = (y * TEXTURE_SIZE + x) * 2;
      slopes[index] = dx;
      slopes[index + 1] = dy;
      steepest = Math.max(steepest, Math.abs(dx), Math.abs(dy));
    }
  }
  for (let i = 0; i < slopes.length; i++) slopes[i] = slopes[i]! / steepest;
  return slopes;
}

export function createWater(ctx: GameContext, options: WaterOptions = {}): Water {
  const { scene, clock } = ctx;
  const rippleSize = options.rippleSize ?? 5;
  const speed = options.speed ?? 0.35;

  const texture = (pixels: Uint8Array): RawTexture => {
    const result = RawTexture.CreateRGBATexture(pixels, TEXTURE_SIZE, TEXTURE_SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    result.wrapU = result.wrapV = Texture.WRAP_ADDRESSMODE;
    result.anisotropicFilteringLevel = 8; // water is nearly always seen at a shallow angle
    return result;
  };
  const SLOPE = 0.35; // how far the steepest ripple tilts the surface, as a normal-map value

  // Large ripples: an ordinary normal map.
  const large = rippleSlopes(7, 26);
  const largePixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let i = 0; i < TEXTURE_SIZE * TEXTURE_SIZE; i++) {
    const nx = -large[i * 2]! * SLOPE;
    const ny = -large[i * 2 + 1]! * SLOPE;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    largePixels.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], i * 4);
  }
  // Small ripples: the material's "detail map", which keeps its normal in the
  // alpha (x) and green (y) channels. Red and blue would adjust colour and
  // roughness; they are switched off below.
  const small = rippleSlopes(23, 26);
  const smallPixels = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let i = 0; i < TEXTURE_SIZE * TEXTURE_SIZE; i++) {
    const nx = -small[i * 2]! * SLOPE;
    const ny = -small[i * 2 + 1]! * SLOPE;
    smallPixels.set([128, (ny * 0.5 + 0.5) * 255, 128, (nx * 0.5 + 0.5) * 255], i * 4);
  }
  const largeRipples = texture(largePixels);
  const smallRipples = texture(smallPixels);
  // Texture coordinates are in metres (see prepareMesh), so scale is 1 / size.
  largeRipples.uScale = largeRipples.vScale = 1 / rippleSize;
  smallRipples.uScale = smallRipples.vScale = 1 / (rippleSize * 0.31);
  smallRipples.wAng = 1.1; // turned, so the two layers never line up

  const material = new PBRMaterial("water", scene);
  material.albedoColor = options.color ?? new Color3(0.012, 0.06, 0.07);
  material.metallic = 0;
  material.roughness = 0.12; // a little spread, or each ripple facet mirrors a different patch of sky and the surface looks blotchy
  material.metallicF0Factor = 0.5; // water reflects about 2% head-on, half what most surfaces do
  material.bumpTexture = largeRipples;
  material.detailMap.texture = smallRipples;
  material.detailMap.isEnabled = true;
  material.detailMap.diffuseBlendLevel = 0;
  material.detailMap.roughnessBlendLevel = 0;
  material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  // Reflections and highlights stay at full strength over the transparency:
  // see-through from above, a mirror toward the horizon.
  material.useRadianceOverAlpha = true;
  material.useSpecularOverAlpha = true;
  // Drawn from both sides: it is also seen from below, and map meshes may be
  // wound either way round (see MaterialOverride in map.ts).
  material.backFaceCulling = false;

  const depth = new WaterDepthPlugin(material);
  const surfaces = new Map<Mesh, Surface>();
  let clarity = 0;
  let rippleStrength = 0;
  const water: Water = {
    material,
    get clarity() {
      return clarity;
    },
    set clarity(value: number) {
      clarity = Math.min(1, Math.max(0, value));
      material.alpha = 1 - clarity * 0.6; // never fully clear: it would stop reading as water
    },
    get rippleStrength() {
      return rippleStrength;
    },
    set rippleStrength(value: number) {
      rippleStrength = Math.max(0, value);
      largeRipples.level = rippleStrength * 1.2;
      material.detailMap.bumpLevel = rippleStrength * 0.8;
    },
    /**
     * Water's ripples are laid out in metres across the world, not by the
     * mesh's own texture coordinates, so a pond unwrapped any old way (or not
     * at all) gets ripples the same size as the sea's. This writes those
     * coordinates: each vertex's horizontal position. It also records the
     * mesh's outline and height for `surfaceAt`. Water meshes are taken to be
     * flat and level.
     */
    prepareMesh(mesh) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      if (!positions) return;
      const world = mesh.computeWorldMatrix(true).m;
      const uvs = new Float32Array((positions.length / 3) * 2);
      let level = 0;
      const surface: Surface = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, triangles: new Float32Array(0), level: 0 };
      for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
        const x = positions[i]!;
        const y = positions[i + 1]!;
        const z = positions[i + 2]!;
        const worldX = (uvs[j] = x * world[0]! + y * world[4]! + z * world[8]! + world[12]!);
        const worldZ = (uvs[j + 1] = x * world[2]! + y * world[6]! + z * world[10]! + world[14]!);
        level += x * world[1]! + y * world[5]! + z * world[9]! + world[13]!;
        surface.minX = Math.min(surface.minX, worldX);
        surface.maxX = Math.max(surface.maxX, worldX);
        surface.minZ = Math.min(surface.minZ, worldZ);
        surface.maxZ = Math.max(surface.maxZ, worldZ);
      }
      mesh.setVerticesData(VertexBuffer.UVKind, uvs);

      const indices = mesh.getIndices() ?? [];
      surface.triangles = new Float32Array(indices.length * 2);
      for (let i = 0; i < indices.length; i++) {
        surface.triangles[i * 2] = uvs[indices[i]! * 2]!;
        surface.triangles[i * 2 + 1] = uvs[indices[i]! * 2 + 1]!;
      }
      surface.level = level / (positions.length / 3);
      surfaces.set(mesh, surface);
      mesh.onDisposeObservable.addOnce(() => surfaces.delete(mesh)); // its chunk unloaded
    },
    surfaceAt(x, z) {
      let highest: number | null = null;
      for (const surface of surfaces.values()) {
        if (x < surface.minX || x > surface.maxX || z < surface.minZ || z > surface.maxZ) continue;
        if (highest !== null && surface.level <= highest) continue;
        for (let i = 0; i < surface.triangles.length; i += 6) {
          if (!insideTriangle(x, z, surface.triangles, i)) continue;
          highest = surface.level;
          break;
        }
      }
      return highest;
    },
    setHeights(heights, baseUrl = "") {
      depth.heights?.texture.dispose();
      depth.heights = null;
      if (heights) {
        // Unfiltered and without mipmaps: the two channels are bytes of one number.
        const texture = new Texture(baseUrl + heights.file, scene, true, true, Texture.NEAREST_SAMPLINGMODE);
        texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
        depth.heights = { texture, info: heights };
      }
      depth.markAllDefinesAsDirty();
    },
    get override() {
      return { material, prepareMesh: water.prepareMesh };
    },
    dispose() {
      depth.heights?.texture.dispose();
      surfaces.clear();
      scene.onBeforeRenderObservable.remove(observer);
      material.dispose(false, true);
    },
  };
  water.clarity = options.clarity ?? 0.45;
  water.rippleStrength = options.rippleStrength ?? 0.5;

  // The two layers drift in different directions, so the pattern never repeats visibly.
  const observer = scene.onBeforeRenderObservable.add(() => {
    const drift = (clock.delta * speed) / rippleSize;
    largeRipples.uOffset += drift * 0.8;
    largeRipples.vOffset += drift * 0.45;
    smallRipples.uOffset -= drift * 1.7;
    smallRipples.vOffset += drift * 2.3;
  });

  return water;
}
