import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import "@babylonjs/core/Meshes/thinInstanceMesh"; // registers thin instances on Mesh
import type { MaterialDefines, Nullable, TargetCamera, UniformBuffer } from "@babylonjs/core";
import type { GameContext } from "./context";
import { timed } from "./perf";
import type { StreamedMap } from "./map";
import type { Wind } from "./wind";

/**
 * Grass: tufts planted over the ground around the camera.
 *
 * Nobody places grass by hand. The level designer says *where it may grow*
 * and the game plants it: a Blender object with the custom property
 * `ground_cover` (the terrain) is covered in tufts, as thickly as its
 * `ground_cover` vertex group says at each point (painted in Weight Paint
 * mode: 1 a meadow, 0 bare, as under roads, houses and water). The map export
 * carries those weights as the mesh's second UV map. Each tuft takes the
 * ground's colour tint at its spot, so grass on dry ground is dry.
 *
 * The tufts are one small mesh drawn many times with Babylon's thin
 * instances: a patch of a few hundred costs one draw call. The ground is cut
 * into patches so that only those near the camera are drawn; beyond
 * `distance` there is none, and the ground's own texture carries the look.
 * Each patch is planted twice over: a thin sward seen out to `distance`, and
 * a thicker one of smaller tufts that only appears close by, where the eye
 * can tell the difference. Neither ends at a line: toward the end of its
 * range each tuft sinks into the ground, some sooner than others, so the
 * grass thins out instead of stopping (and never pops in as you walk).
 *
 * The blades sway in the wind (wind.ts) and don't cast shadows.
 */

export interface GroundCoverOptions {
  /** Tufts per square metre where cover is full. */
  density?: number;
  /** Grass is drawn out to this far from the camera (m). */
  distance?: number;
  /** The extra, thicker grass is drawn out to this far (m). */
  nearDistance?: number;
  /** How many more tufts the thicker grass adds, as a multiple of `density`. */
  nearBoost?: number;
  /** Size of the patches the ground is cut into (m). Smaller patches follow the camera more closely but cost more draw calls. */
  patch?: number;
  /** The grass's own colour, before the ground's tint. */
  color?: Color3;
  /** Makes the grass sway. */
  wind?: Wind;
}

export interface GroundCover {
  /** Tufts currently planted (in every patch, drawn or not). */
  readonly count: number;
  dispose(): void;
}

/**
 * Planting time per frame (ms). One piece of ground takes 15 to 30 ms to
 * plant, which as a single lump is a dropped frame or two every time new
 * ground arrives; so it is done a slice at a time.
 */
const PLANTING_SLICE = 2;
/** Patches are checked against the camera this often (frames). */
const CHECK_EVERY = 12;
/** The close-up sward is many fine blades spread wide, so neighbouring tufts run together; the distant one is fewer, broader blades that still read from far off. */
const NEAR_TUFT = { blades: 12, spread: 0.07, wide: 1 };
const FAR_TUFT = { blades: 6, spread: 0.04, wide: 1.7 };

/** A small fixed random generator, so the same ground always grows the same grass. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

/**
 * Thins the grass out toward the end of its range. Each tuft is drawn toward
 * its own root as it nears the limit, each starting at a slightly different
 * distance, so the far edge is ragged and sparse, like real grass seen
 * across a field. A tuft that has shrunk to a point costs nothing to fill.
 */
class CoverFadePlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly camera: TargetCamera,
    /** Tufts start to shrink here and are gone here (m from the camera). */
    private readonly from: number,
    private readonly to: number,
  ) {
    super(material, "CoverFade", 130, { COVERFADE: false }, true, true); // after the wind (120): it shrinks the swayed blade
  }

  override getClassName(): string {
    return "CoverFadePlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>).COVERFADE = true;
  }

  override getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string } {
    return { ubo: [{ name: "coverFade", size: 4, type: "vec4" }], vertex: `uniform vec4 coverFade;` };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const eye = this.camera.globalPosition;
    uniformBuffer.updateFloat4("coverFade", eye.x, eye.z, this.from, this.to);
  }

  override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<Record<string, string>> {
    if (shaderType !== "vertex") return null;
    // `finalWorld` is the tuft's own placement, so its last column is the root.
    return shaderLanguage === ShaderLanguage.WGSL
      ? {
          CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#ifdef COVERFADE
{
    let coverRoot: vec3f = finalWorld[3].xyz;
    let coverRagged: f32 = fract(sin(dot(coverRoot.xz, vec2f(12.9898, 78.233))) * 43758.5453);
    let coverAway: f32 = distance(coverRoot.xz, uniforms.coverFade.xy) + (coverRagged - 0.5) * (uniforms.coverFade.w - uniforms.coverFade.z);
    let coverKept: f32 = 1.0 - smoothstep(uniforms.coverFade.z, uniforms.coverFade.w, coverAway);
    worldPos = vec4f(mix(coverRoot, worldPos.xyz, coverKept), worldPos.w);
}
#endif
`,
        }
      : {
          CUSTOM_VERTEX_UPDATE_WORLDPOS: `
#ifdef COVERFADE
{
    vec3 coverRoot = finalWorld[3].xyz;
    float coverRagged = fract(sin(dot(coverRoot.xz, vec2(12.9898, 78.233))) * 43758.5453);
    float coverAway = distance(coverRoot.xz, coverFade.xy) + (coverRagged - 0.5) * (coverFade.w - coverFade.z);
    float coverKept = 1.0 - smoothstep(coverFade.z, coverFade.w, coverAway);
    worldPos.xyz = mix(coverRoot, worldPos.xyz, coverKept);
}
#endif
`,
        };
  }
}

/**
 * One tuft: a few blades leaning out from a point, each a narrow strip that
 * tapers to a tip. Dark at the root and light at the tip (as vertex colours),
 * with normals pointing mostly up so a tuft is lit like the ground it stands
 * on rather than flickering blade by blade.
 */
function tuft(ctx: GameContext, color: Color3, shape: { blades: number; spread: number; wide: number }): Mesh {
  const random = seeded(99);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const sway: number[] = []; // second UV map: how much each vertex moves in the wind, and the blade's phase
  const indices: number[] = [];
  for (let blade = 0; blade < shape.blades; blade++) {
    const phase = random();
    const turn = (blade / shape.blades) * Math.PI * 2 + random() * 0.8;
    const lean = 0.025 + random() * 0.09; // how far the tip ends up from the root
    const tall = 0.09 + random() * 0.14;
    const wide = (0.008 + random() * 0.006) * shape.wide; // real blades are narrow: wide ones read as a succulent
    const outX = Math.cos(turn);
    const outZ = Math.sin(turn);
    const from = shape.spread * (0.25 + random() * 0.75);
    const rootX = outX * from;
    const rootZ = outZ * from;
    const base = positions.length / 3;
    // Root pair, middle pair, tip: across the blade is at right angles to its lean.
    for (const [up, out, half, shade] of [
      [0, 0, wide, 0.6], // not much darker than the ground: a near-black root turns every tuft into a dot
      [0.55, 0.35, wide * 0.75, 0.78],
      [1, 1, 0, 1.0],
    ] as const) {
      const x = rootX + outX * lean * out;
      const z = rootZ + outZ * lean * out;
      const sides = half > 0 ? [-1, 1] : [0];
      for (const side of sides) {
        positions.push(x - outZ * half * side, tall * up, z + outX * half * side);
        normals.push(outX * 0.25, 0.95, outZ * 0.25);
        colors.push(shade, shade, shade, 1);
        sway.push(up * up, phase); // rooted at the base, freest at the tip
      }
    }
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const mesh = new Mesh("grass-tuft", ctx.scene);
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.colors = colors;
  data.uvs2 = sway;
  data.indices = indices;
  data.applyToMesh(mesh);

  const material = new PBRMaterial("grass", ctx.scene);
  material.albedoColor = color;
  material.metallic = 0;
  material.roughness = 0.9;
  material.metallicF0Factor = 0.4; // matt: wet-looking glints on every blade read as plastic
  material.backFaceCulling = false; // blades are seen from both sides
  mesh.material = material;
  mesh.setEnabled(false); // the pattern the patches are copies of; never drawn itself
  return mesh;
}

interface Patch {
  mesh: Mesh;
  x: number;
  z: number;
  count: number;
  /** Shown only within the near distance. */
  near: boolean;
}

export function createGroundCover(ctx: GameContext, map: StreamedMap, options: GroundCoverOptions = {}): GroundCover {
  const { scene, camera, quality } = ctx;
  const density = (options.density ?? 7) * quality.groundCover;
  const distance = options.distance ?? 48;
  const nearDistance = options.nearDistance ?? 18;
  const nearBoost = options.nearBoost ?? 2.2;
  const patchSize = options.patch ?? 12;
  if (density <= 0) return { count: 0, dispose() {} };

  // Multiplied by the ground's own tint at each tuft, so this is "a little brighter than the ground".
  // Two copies of the tuft, because the two swards thin out at different distances.
  const color = options.color ?? new Color3(0.34, 0.36, 0.16);
  const sources = { far: tuft(ctx, color, FAR_TUFT), near: tuft(ctx, color, NEAR_TUFT) };
  for (const [source, reach] of [[sources.far, distance], [sources.near, nearDistance]] as const) {
    const material = source.material as PBRMaterial;
    options.wind?.attach(material, 1.3);
    // The ragged edge is half the fade's width either way, so start well inside the limit.
    new CoverFadePlugin(material, camera, reach * 0.55, reach * 0.85);
  }
  /** The patches grown on each piece of ground, or null while it waits its turn. */
  const planted = new Map<Mesh, Patch[] | null>();
  let total = 0;

  /**
   * Plants one piece of ground: scatters tufts over its triangles and sorts
   * them into patches. Written as steps (it yields every so often) so the
   * frame loop can do a little each frame; `made` collects the patches as
   * they are finished, so a job abandoned half-way can be cleaned up.
   */
  function* plant(ground: Mesh, made: Patch[]): Generator<void, void> {
    const positions = ground.getVerticesData(VertexBuffer.PositionKind);
    const indices = ground.getIndices();
    if (!positions || !indices) return;
    const colors = ground.getVerticesData(VertexBuffer.ColorKind);
    const stride = ground.getVertexBuffer(VertexBuffer.ColorKind)?.getSize() ?? 4;
    const weights = ground.getVerticesData(VertexBuffer.UV2Kind); // u = how thickly it grows; absent means everywhere
    const random = seeded(hash(ground.name));
    type Tier = { matrices: number[]; tints: number[] };
    const cells = new Map<string, { x: number; z: number; far: Tier; near: Tier }>();

    for (let t = 0; t < indices.length; t += 3) {
      if (t % 192 === 0) yield;
      const a = indices[t]! * 3;
      const b = indices[t + 1]! * 3;
      const c = indices[t + 2]! * 3;
      const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
      const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
      const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
      // Area as seen from above: a steep bank grows no more grass than its footprint.
      const area = Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
      // Weights are painted per vertex and blend across each triangle, so a
      // road's bare strip has a fringe of small values a metre or two wide.
      // Nothing grows below a quarter: no stray blades coming up through paving.
      const thickness = (corner: number): number => (weights ? Math.max(0, (weights[(corner / 3) * 2]! - 0.25) / 0.75) : 1);
      const coverA = thickness(a), coverB = thickness(b), coverC = thickness(c);
      const expected = area * density * (1 + nearBoost) * Math.max(coverA, coverB, coverC);
      const tries = Math.floor(expected) + (random() < expected % 1 ? 1 : 0);
      for (let i = 0; i < tries; i++) {
        // A random point in the triangle.
        let u = random();
        let v = random();
        if (u + v > 1) {
          u = 1 - u;
          v = 1 - v;
        }
        const w = 1 - u - v;
        const cover = coverA * w + coverB * u + coverC * v;
        if (random() * Math.max(coverA, coverB, coverC) > cover) continue; // thin out toward bare ground
        const x = ax * w + bx * u + cx * v;
        const y = ay * w + by * u + cy * v;
        const z = az * w + bz * u + cz * v;

        const key = `${Math.floor(x / patchSize)},${Math.floor(z / patchSize)}`;
        let cell = cells.get(key);
        if (!cell) {
          cell = {
            x: (Math.floor(x / patchSize) + 0.5) * patchSize,
            z: (Math.floor(z / patchSize) + 0.5) * patchSize,
            far: { matrices: [], tints: [] },
            near: { matrices: [], tints: [] },
          };
          cells.set(key, cell);
        }
        // Most tufts belong to the thicker, close-up sward and are a little smaller.
        const close = random() < nearBoost / (1 + nearBoost);
        const tier = close ? cell.near : cell.far;
        // Where it stands, turned any way round, a little bigger or smaller than its neighbours.
        const turn = random() * Math.PI * 2;
        const size = (0.7 + random() * 0.8) * (close ? 0.8 : 1);
        const tall = size * (0.7 + random() ** 4 * 1.7); // mostly short, with the odd tall clump
        const cos = Math.cos(turn) * size;
        const sin = Math.sin(turn) * size;
        tier.matrices.push(cos, 0, -sin, 0, 0, tall, 0, 0, sin, 0, cos, 0, x, y - 0.02, z, 1);
        // The ground's tint here, a shade lighter or darker.
        const light = 0.82 + random() * 0.36;
        const tint = (channel: number): number =>
          colors ? (colors[(a / 3) * stride + channel]! * w + colors[(b / 3) * stride + channel]! * u + colors[(c / 3) * stride + channel]! * v) * light : light;
        tier.tints.push(tint(0), tint(1), tint(2), 1);
      }
    }

    const patches = made;
    for (const [cell, tier, near] of [...cells.values()].flatMap((c) => [[c, c.far, false], [c, c.near, true]] as const)) {
      if (tier.matrices.length === 0) continue;
      yield;
      const mesh = (near ? sources.near : sources.far).clone(`grass:${ground.name}:${patches.length}`);
      // Its own copy of the (tiny) tuft: meshes that share geometry also share
      // the record of which instance buffers go with it, and each patch has its own.
      mesh.makeGeometryUnique();
      mesh.thinInstanceSetBuffer("matrix", new Float32Array(tier.matrices), 16, true);
      mesh.thinInstanceSetBuffer("color", new Float32Array(tier.tints), 4, true);
      mesh.thinInstanceRefreshBoundingInfo();
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.setEnabled(false); // until the camera is near
      const count = tier.matrices.length / 16;
      total += count;
      patches.push({ mesh, x: cell.x, z: cell.z, count, near });
    }
  }

  /** The piece of ground being planted at the moment, if any. */
  let planting: { ground: Mesh; steps: Generator<void, void>; made: Patch[] } | null = null;

  function uproot(ground: Mesh): void {
    if (planting?.ground === ground) {
      for (const patch of planting.made) {
        total -= patch.count;
        patch.mesh.dispose();
      }
      planting = null;
    }
    for (const patch of planted.get(ground) ?? []) {
      total -= patch.count;
      patch.mesh.dispose();
    }
    planted.delete(ground);
  }

  /** Brings the list of grounds in line with what the map has loaded. */
  function survey(): void {
    const current = new Set(map.meshesWith("ground_cover").map((entry) => entry.mesh));
    for (const ground of [...planted.keys()]) if (!current.has(ground)) uproot(ground);
    for (const ground of current) if (!planted.has(ground)) planted.set(ground, null);
  }
  const mapObserver = map.onDetailChanged.add(survey);
  survey();

  let frame = 0;
  const frameObserver = scene.onBeforeRenderObservable.add(() => {
    // Plant what is waiting, a couple of milliseconds' worth per frame.
    timed("plant grass", () => {
      const until = performance.now() + PLANTING_SLICE;
      do {
        if (!planting) {
          for (const [ground, patches] of planted) {
            if (patches !== null) continue;
            if (ground.isDisposed()) {
              planted.delete(ground);
              continue;
            }
            const made: Patch[] = [];
            planting = { ground, steps: plant(ground, made), made };
            break;
          }
          if (!planting) break; // nothing waiting
        }
        if (planting.ground.isDisposed()) {
          uproot(planting.ground);
          continue;
        }
        if (planting.steps.next().done) {
          planted.set(planting.ground, planting.made);
          planting = null;
        }
      } while (performance.now() < until);
    });

    if (frame++ % CHECK_EVERY !== 0) return;
    const eye = camera.globalPosition;
    for (const patches of planted.values()) {
      for (const patch of patches ?? []) {
        const reach = (patch.near ? nearDistance : distance) + patchSize * 0.7; // to the patch's far corner
        const away = Math.hypot(patch.x - eye.x, patch.z - eye.z);
        // A little slack between appearing and disappearing, so a patch at the edge doesn't flicker.
        const show = away < (patch.mesh.isEnabled() ? reach + 3 : reach);
        if (show !== patch.mesh.isEnabled()) patch.mesh.setEnabled(show);
      }
    }
  });

  return {
    get count() {
      return total;
    },
    dispose() {
      map.onDetailChanged.remove(mapObserver);
      scene.onBeforeRenderObservable.remove(frameObserver);
      for (const ground of [...planted.keys()]) uproot(ground);
      for (const source of [sources.far, sources.near]) {
        source.material?.dispose();
        source.dispose();
      }
    },
  };
}
