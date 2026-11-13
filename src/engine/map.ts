import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Material } from "@babylonjs/core/Materials/material";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/thinInstanceMesh"; // registers thin instances on Mesh
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Observable } from "@babylonjs/core/Misc/observable";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox, PhysicsShapeContainer, PhysicsShapeConvexHull, PhysicsShapeCylinder, PhysicsShapeMesh, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape";
import type { AbstractMesh, AssetContainer, PBRMaterial, PhysicsShape, Scene } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { registerGLTFExtension, unregisterGLTFExtension } from "@babylonjs/loaders/glTF/2.0/glTFLoaderExtensionRegistry";
import type { GameContext } from "./context";
import { FoliagePlugin } from "./foliage";
import { timed } from "./perf";
import { setCasterGroups } from "./shadowCulling";
import { MapSurfacePlugin } from "./surfacePlugin";
import type { Wind } from "./wind";

// --- Manifest (written by tools/blender/export_map.py) -----------------------

export interface MapLod {
  file: string;
  triangles: number;
  bytes: number;
}

export interface MapChunk {
  id: string;
  /** World-space bounding box. */
  min: [number, number, number];
  max: [number, number, number];
  /** [0] full detail, [1] (optional) decimated version for the distance. */
  lods: MapLod[];
}

/** An Empty placed in Blender: a spawn point, trigger position, point of interest… */
/** Custom properties of a Blender material that the loader acts on (see `finish` in loadMap). */
interface SurfaceExtras {
  metres?: number;
  variation?: number;
  detile?: number;
  wind?: number;
  foliage?: boolean;
  alpha_cutoff?: number;
  impostor?: boolean;
  matte?: boolean;
  gain?: number;
}

export interface MapMarker {
  name: string;
  position: [number, number, number];
  /** Facing, as a rotation about the vertical axis in radians. */
  yaw: number;
  /** How the Empty is drawn in Blender: a sphere, or anything else as a box. Trigger zones take their volume from this. */
  shape?: "box" | "sphere";
  /** Width, height and depth in metres, before `yaw` is applied. */
  size?: [number, number, number];
  /** The Empty's custom properties. */
  props: Record<string, string | number | boolean>;
}

export interface MapManifest {
  version: number;
  name: string;
  chunkSize: number;
  min: [number, number, number];
  max: [number, number, number];
  /** Objects flagged `always_loaded` in Blender. */
  global: MapLod | null;
  /** The texture files in `textures/`, shared by every chunk. `ktx2`: GPU-compressed, needing Babylon's KTX2 decoder. */
  textures?: { count: number; bytes: number; ktx2: boolean } | null;
  markers: MapMarker[];
  /** Second materials blended into others through a mask image: a path worn into grass. */
  blends?: MapBlend[];
  /** The terrain's height baked into an image (see `height_map` in export_map.py), or null. */
  heights?: { file: string; size: number; map: [number, number, number, number]; low: number; range: number } | null;
  chunks: MapChunk[];
}

export interface MapBlend {
  /** The material blended into, and the one that shows where the mask is white. */
  material: string;
  layer: string;
  /** The mask image, relative to the manifest. */
  mask: string;
  /** Mask u = x * map[0] + map[2], v = z * map[1] + map[3]. */
  map: [number, number, number, number];
}

/** Custom properties set on objects in Blender (see export_map.py). */
interface ObjectExtras {
  collision?: "mesh" | "convex" | "box" | "sphere" | "cylinder" | "none";
  collision_radius?: number;
  collider_only?: boolean | number;
  shadows?: boolean | number;
  /** Written by the exporter on linked duplicates: the name of their shared mesh. */
  mesh_id?: string;
  /** Written by the exporter on the one full copy of a shared mesh (in the always-loaded file): a source for instances, not something placed in the world. */
  library?: boolean | number;
}

export interface MapOptions {
  /** Chunks nearer than this are loaded at full detail, with physics and shadows. */
  detailDistance?: number;
  /** Chunks nearer than this are loaded at all. Further ones are unloaded. */
  viewDistance?: number;
  /** How many chunk files may download/parse at once. */
  maxConcurrentLoads?: number;
  /** Thicken the scene's fog so the edge of the loaded world fades out instead of popping. */
  fog?: boolean;
  /**
   * Materials made in code that take the place of Blender materials, by name:
   * water, or anything else that needs more than Blender can describe.
   * Everything in the map that uses a material of that name is drawn with
   * yours instead, and the Blender one (and its textures) is never loaded.
   */
  materials?: Record<string, MaterialOverride>;
  /** Makes the map's plants sway: materials with the Blender custom property `wind` are attached to it. */
  wind?: Wind;
  /**
   * Where the map's own origin goes in the world. For a second map in the
   * same scene (an interior beside the level it belongs to, see spaces.ts):
   * everything in it, its markers and its chunks are moved by this much, so
   * its author builds it around zero and never thinks about where it lands.
   */
  origin?: Vector3;
}

export interface MaterialOverride {
  /**
   * Yours to dispose; the map never does. Turn `backFaceCulling` off on it:
   * map meshes are wound the glTF way, the reverse of meshes made in code,
   * which goes unnoticed with Blender's own materials because they arrive
   * double-sided.
   */
  material: Material;
  /** Called once for each mesh that will be drawn with it, after the mesh is in its final place. */
  prepareMesh?(mesh: Mesh): void;
}

export interface MapStats {
  /** Chunks currently in the scene at full detail / as far versions. */
  detailed: number;
  far: number;
  loading: number;
  total: number;
  triangles: number;
}

/** Something upright to walk around (a tree trunk, a pillar, a boulder), approximated as a cylinder. */
export interface MapObstacle {
  /** Centre of the base. */
  position: Vector3;
  radius: number;
  height: number;
}

export interface StreamedMap {
  readonly manifest: MapManifest;
  /** Where the map's files are served from, for the images the manifest names. */
  readonly baseUrl: string;
  detailDistance: number;
  viewDistance: number;
  readonly stats: MapStats;
  /** Finds a marker by exact name. */
  marker(name: string): MapMarker | undefined;
  /**
   * Resolves once everything within `radius` of a point is loaded at full
   * detail — call before spawning something there so it has ground to stand on.
   */
  whenLoadedAround(position: Vector3, radius?: number): Promise<void>;
  /**
   * Streams around this point instead of the camera, until called with null.
   * For when the camera is somewhere this map is not (inside a building that
   * is its own map): what is loaded stays exactly as the player left it.
   */
  hold(point: Vector3 | null): void;
  /**
   * False hides everything the map has loaded, and whatever it loads while
   * hidden: nothing of it is drawn or casts a shadow. Its collision stays.
   * For a map the player is not in (see spaces.ts).
   */
  shown: boolean;
  /**
   * Register a movable physics body that rests on the map. While the ground
   * under it isn't loaded with collision it is held in place, instead of
   * falling out of the world; it starts moving again when the player returns.
   */
  anchor(body: PhysicsBody): void;
  /** Fires when chunks gain or lose full detail, and with it their collision. */
  readonly onDetailChanged: Observable<void>;
  /**
   * The static collision currently loaded, for things that need to reason
   * about where characters can go (AI navigation). `meshes` hold world-space
   * triangles with no transform; `obstacles` stand in for everything collided
   * with as a simple shape (trees, pillars, rocks).
   */
  collisionGeometry(): { meshes: Mesh[]; obstacles: MapObstacle[] };
  /**
   * The unique (not instanced) meshes loaded at full detail whose Blender
   * object has a custom property of this name, with its value. A way for the
   * game to act on parts of the map picked out by the level designer, such as
   * the ground that grass should grow on. Changes with `onDetailChanged`.
   */
  meshesWith(property: string): { mesh: Mesh; value: string | number | boolean }[];
  dispose(): void;
}

type Level = "none" | "far" | "detail";

/** What one loaded chunk file put into the scene, so it can all be removed again. */
interface Loaded {
  level: Exclude<Level, "none">;
  triangles: number;
  /** Baked collision meshes and simple-shape obstacles (full-detail chunks only). */
  walkable: Mesh[];
  /** Unique meshes and their Blender object's custom properties (full-detail chunks only). */
  tagged: Map<Mesh, ObjectExtras>;
  obstacles: MapObstacle[];
  /** Shows or hides everything this file put in the scene. */
  show(on: boolean): void;
  dispose(): void;
}

interface ChunkState {
  info: MapChunk;
  loaded: Loaded | null;
  /** The level currently being fetched, if any. */
  loading: Level;
  want: Level;
  distance: number;
  /** Set when a file failed to load, so it isn't retried forever or waited on. */
  failed: boolean;
}

/** A material every chunk that names it draws with, and how many of them are loaded. */
interface SharedMaterial {
  material: Material;
  users: number;
}

/** How far a surface is lightened, darkened and tinted in blotches: 0 none, 1 harsh. */
const VARIATION_STRENGTH = 0.55;

/**
 * A soft, cloudy greyscale pattern that repeats seamlessly, in the layout of
 * Babylon's "detail map" (red adjusts colour; the other channels are left
 * neutral). Laid over a tiled texture at a much larger scale, it lightens
 * some repeats and darkens others, so the eye stops finding the grid.
 */
function variationTexture(scene: Scene): RawTexture {
  const size = 256;
  let state = 12345;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  // A sum of waves that each fit the square a whole number of times: seamless.
  const waves = Array.from({ length: 18 }, () => {
    const frequency = 1 + Math.floor(random() * 5);
    const angle = random() * Math.PI * 2;
    return { kx: Math.round(Math.cos(angle) * frequency), ky: Math.round(Math.sin(angle) * frequency), phase: random() * Math.PI * 2, height: 1 / frequency };
  });
  const values = new Float32Array(size * size);
  let lowest = Infinity;
  let highest = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      for (const wave of waves) value += Math.sin(((wave.kx * x + wave.ky * y) / size) * Math.PI * 2 + wave.phase) * wave.height;
      values[y * size + x] = value;
      lowest = Math.min(lowest, value);
      highest = Math.max(highest, value);
    }
  }
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < values.length; i++) {
    const grey = (values[i]! - lowest) / (highest - lowest); // 0..1, about 0.5 on average
    const level = Math.round(grey * 255);
    pixels.set([level, level, level, 255], i * 4);
  }
  const texture = RawTexture.CreateRGBATexture(pixels, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

const MIRROR_X = Matrix.Scaling(-1, 1, 1);
const isTrue = (value: unknown): boolean => value === true || value === 1;

// --- Sharing materials and textures between chunk files ----------------------
//
// Every chunk file describes the materials it uses, so "Bark" arrives again
// with each one. A map keeps a single copy per name. This hook into Babylon's
// glTF loader hands that copy to a chunk file as it loads, *before* the loader
// builds its own, so the material's textures are not fetched again either.
//
// (When two files do load the same texture, say two chunks arriving at once,
// Babylon still keeps one copy on the GPU: its texture cache is keyed by URL,
// and the chunk files all point at the same files in `textures/`.)

const SHARED_MATERIALS = "map_shared_materials";
type MaterialLookup = (name: string) => Material | undefined;

unregisterGLTFExtension(SHARED_MATERIALS); // so a hot reload of this module doesn't register it twice
registerGLTFExtension(SHARED_MATERIALS, false, (loader) => {
  const find = loader.parent.extensionOptions[SHARED_MATERIALS]?.find as MaterialLookup | undefined;
  return {
    name: SHARED_MATERIALS,
    enabled: find !== undefined, // only files loaded by a map pass a lookup
    dispose() {},
    _loadMaterialAsync(_context, material, _mesh, drawMode, assign) {
      const shared = drawMode === Material.TriangleFillMode && material.name ? find?.(material.name) : undefined;
      if (!shared) return null; // not seen before: the loader builds it as usual
      assign(shared);
      return Promise.resolve(shared);
    },
  };
});

/**
 * KTX2 textures are unpacked by Babylon's decoder, in worker threads. Babylon
 * would download it from its CDN; `tools/map.mjs` keeps a copy in
 * `public/babylon/ktx2/` instead, and this points Babylon there. It has to
 * happen before the first KTX2 texture of any kind is created, which is also
 * when the decoder is fetched: maps without KTX2 textures never load it.
 */
async function useLocalKtx2Decoder(): Promise<void> {
  const { KhronosTextureContainer2 } = await import("@babylonjs/core/Misc/khronosTextureContainer2");
  const file = (name: string): string => `/babylon/ktx2/${name}`;
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: file("babylon.ktx2Decoder.js"),
    wasmUASTCToASTC: file("uastc_astc.wasm"),
    wasmUASTCToBC7: file("uastc_bc7.wasm"),
    wasmUASTCToRGBA_UNORM: file("uastc_rgba8_unorm_v2.wasm"),
    wasmUASTCToRGBA_SRGB: file("uastc_rgba8_srgb_v2.wasm"),
    wasmUASTCToR8_UNORM: file("uastc_r8_unorm.wasm"),
    wasmUASTCToRG8_UNORM: file("uastc_rg8_unorm.wasm"),
    jsMSCTranscoder: file("msc_basis_transcoder.js"),
    wasmMSCTranscoder: file("msc_basis_transcoder.wasm"),
    wasmZSTDDecoder: file("zstddec.wasm"),
  };
}

/**
 * Loads a map exported from Blender and streams it around the camera: nearby
 * chunks at full detail with collision, distant ones as cheap stand-ins,
 * everything else not in memory at all.
 *
 * What keeps it fast:
 * - only chunks within `viewDistance` exist; only those within
 *   `detailDistance` have physics or cast shadows;
 * - materials are shared across chunks (matched by name), so the same grass or
 *   bark is one material however many chunks use it, and its textures are
 *   loaded once; both are freed when the last chunk using them unloads;
 * - Blender's linked duplicates are pooled: one mesh for the whole map, drawn
 *   as GPU instances in a single batch however many chunks they span;
 * - static geometry has its transform baked in and frozen;
 * - each chunk's colliders live on a single static physics body.
 */
export async function loadMap(ctx: GameContext, url: string, options: MapOptions = {}): Promise<StreamedMap> {
  const { scene, camera, lighting } = ctx;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Map manifest not found: ${url} (${response.status})`);
  const manifest = (await response.json()) as MapManifest;
  const baseUrl = url.slice(0, url.lastIndexOf("/") + 1);
  // A map placed away from zero: everything the manifest says in world
  // coordinates moves with it. (The files' contents are moved as they load.)
  const origin = options.origin?.clone() ?? Vector3.Zero();
  if (origin.lengthSquared() > 0) {
    const shift = (point: [number, number, number]): void => {
      point[0] += origin.x;
      point[1] += origin.y;
      point[2] += origin.z;
    };
    shift(manifest.min);
    shift(manifest.max);
    for (const marker of manifest.markers) shift(marker.position);
    for (const chunk of manifest.chunks) {
      shift(chunk.min);
      shift(chunk.max);
    }
    // Images laid over the ground from above: u = x * a + c, v = z * b + d.
    for (const laid of [...(manifest.blends ?? []), ...(manifest.heights ? [manifest.heights] : [])]) {
      laid.map[2] -= origin.x * laid.map[0];
      laid.map[3] -= origin.z * laid.map[1];
    }
    if (manifest.heights) manifest.heights.low += origin.y;
  }
  if (manifest.textures?.ktx2) await useLocalKtx2Decoder();

  const hysteresis = manifest.chunkSize * 0.25; // stops chunks flickering at a boundary
  const maxConcurrentLoads = options.maxConcurrentLoads ?? 3;
  let detailDistance = options.detailDistance ?? manifest.chunkSize * 1.5;
  let viewDistance = options.viewDistance ?? 400;
  const applyFog = (): void => {
    if (options.fog !== false) scene.fogDensity = 1.75 / viewDistance; // ~5% visibility at the edge
  };
  applyFog();

  const materials = new Map<string, SharedMaterial>();
  // Materials supplied by the game stand in from the start. They count one
  // user that never leaves, so the map neither frees nor disposes them.
  const supplied = new Map<Material, MaterialOverride>();
  for (const [name, override] of Object.entries(options.materials ?? {})) {
    materials.set(name, { material: override.material, users: 1 });
    supplied.set(override.material, override);
  }
  const pool = new Map<string, Mesh>(); // one hidden source mesh per shared Blender mesh
  // glTF content sits under a mirrored root. Instances only batch with a source
  // of the same handedness, so pooled sources get a mirrored parent as well.
  const poolRoot = new TransformNode("map:pool", scene);
  poolRoot.scaling.x = -1;
  const chunks: ChunkState[] = manifest.chunks.map((info) => ({
    info,
    loaded: null,
    loading: "none",
    want: "none",
    distance: Infinity,
    failed: false,
  }));
  const anchored = new Map<PhysicsBody, boolean>(); // movable body -> currently held in place?
  const onDetailChanged = new Observable<void>();
  const pins = new Set<Vector3>(); // extra points to keep loaded around, besides the camera
  let held: Vector3 | null = null; // streams around here instead of the camera (see `hold`)
  let shown = true;
  const waiters: Array<() => void> = [];
  let activeLoads = 0;
  let disposed = false;

  // --- Turning a loaded .glb into scene content ------------------------------

  /** Loads one of the map's files, borrowing the materials the map already has (see SHARED_MATERIALS). */
  function loadFile(file: string): Promise<AssetContainer> {
    const find: MaterialLookup = (name) => materials.get(name)?.material;
    return LoadAssetContainerAsync(baseUrl + file, scene, {
      pluginOptions: { gltf: { extensionOptions: { [SHARED_MATERIALS]: { find } } } },
    });
  }

  /**
   * Makes the materials a file brought with it the map's shared copies, and
   * returns every shared material the file draws with (to be released when it
   * unloads).
   */
  function shareMaterials(container: AssetContainer): SharedMaterial[] {
    const used = new Set<SharedMaterial>();
    for (const mesh of container.meshes) {
      const material = mesh.material;
      if (!material) continue;
      let shared = materials.get(material.name);
      if (!shared) {
        shared = { material, users: 0 };
        materials.set(material.name, shared);
        finish(material);
      }
      if (shared.material !== material) mesh.material = shared.material;
      used.add(shared);
    }
    for (const shared of used) shared.users++;

    // What the file brought that the map isn't keeping is a duplicate: another
    // file that was loading at the same time got in first. Its textures go too;
    // the GPU copies stay, since the shared material's textures use them.
    const kept = new Set([...used].map((shared) => shared.material));
    for (const material of [...container.materials]) {
      if (!kept.has(material)) material.dispose(false, true); // (looping over a copy: disposing edits the list)
    }
    // The survivors belong to the map now, not to this file.
    container.materials.length = 0;
    container.textures.length = 0;
    return [...used];
  }

  /**
   * What every textured map material gets on arrival.
   *
   * Sharp filtering at shallow angles: ground and long walls are mostly seen
   * edge-on, where the default setting smears a texture a few metres away.
   *
   * And the surface plugin (surfacePlugin.ts), against visible tiling, driven
   * by custom properties on the Blender material:
   *   `metres`     how much ground one repeat of its texture covers (set by
   *                tools/blender/surfaces.py);
   *   `variation`  strength of the blotches, 0 to 1 (default 0.55);
   *   `detile`     0 to 1: also show a shifted copy in patches and a larger
   *                one with distance. For organic surfaces only.
   * Blends listed in the manifest are attached once both of their materials
   * have arrived.
   */
  let variation: RawTexture | null = null;
  const surfaces = new Map<string, MapSurfacePlugin>();
  const blended = new Set<MapBlend>();
  const masks: Texture[] = [];
  function finish(material: Material): void {
    if (material.getClassName() !== "PBRMaterial") return;
    const pbr = material as PBRMaterial;
    const extras = surfaceExtras(pbr);
    if (extras.wind && options.wind) options.wind.attach(pbr, extras.wind);
    if (extras.foliage) {
      // Leaf cards (tools/blender/plants.py). Their normals point out of the
      // crown so that it shades as one soft volume; the loader's two-sided
      // lighting would flip them on every card seen from behind and bring
      // back card-by-card flicker.
      pbr.twoSidedLighting = false;
      pbr.backFaceCulling = false;
      // No mirror-like reflection at all. Even a little puts a white rim of
      // reflected sky along the top of every crown seen against the light.
      pbr.metallicF0Factor = 0;
      // The real cut-out is done by the foliage plugin, which keeps crowns
      // full at a distance. The material's own cut-off is left low for the
      // shadow pass, so shadows are cast by slightly fuller leaves and never thin.
      pbr.alphaCutOff = 0.3;
      if (pbr.albedoTexture) {
        new FoliagePlugin(pbr, { cutoff: extras.alpha_cutoff ?? 0.5, textureSize: pbr.albedoTexture.getSize().width || 1024, sun: lighting.sun });
      }
    }
    if (extras.matte) {
      // Scanned plants (tools/blender/plants.py `import_model`). A scan cut
      // down to a few hundred triangles has leaves made of large flat facets,
      // and each one mirrors the sky as a white sheet: wet plastic. Nearly
      // all of the mirror-like reflection is taken off; the scan's own
      // roughness map still shapes what is left.
      pbr.metallicF0Factor = 0.1;
    }
    if (extras.gain && extras.gain !== 1) {
      // A photographed leaf is darker than this scene's painted grass and
      // trees, and reads as a black hole among them. `gain` brightens the
      // material's colour to sit with its neighbours.
      pbr.albedoColor = pbr.albedoColor.scale(extras.gain);
    }
    if (extras.impostor) {
      // The far version's material when the map has picture cards of trees in
      // it (see `impostor` in tools/blender/export_map.py). The cards are
      // seen from both sides and carry normals that shade them as a rounded
      // crown either way round, which two-sided lighting would flip.
      pbr.twoSidedLighting = false;
      pbr.backFaceCulling = false;
    }
    if (pbr.albedoTexture) {
      // A card seen edge-on should blur away below the cut-off, not be
      // sharpened into a solid streak, so foliage gets no anisotropic filtering.
      for (const texture of pbr.getActiveTextures()) texture.anisotropicFilteringLevel = extras.foliage || extras.impostor ? 1 : 16;
      variation ??= variationTexture(scene);
      surfaces.set(
        pbr.name,
        new MapSurfacePlugin(pbr, {
          noise: variation,
          metres: extras.metres ?? 2,
          variation: extras.variation ?? VARIATION_STRENGTH,
          detile: extras.detile ?? 0,
        }),
      );
    }
    for (const blend of manifest.blends ?? []) {
      if (blended.has(blend)) continue;
      const surface = surfaces.get(blend.material);
      const layer = materials.get(blend.layer)?.material as PBRMaterial | undefined;
      if (!surface || !layer?.albedoTexture) continue;
      const mask = new Texture(baseUrl + blend.mask, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      mask.wrapU = mask.wrapV = Texture.CLAMP_ADDRESSMODE;
      mask.anisotropicFilteringLevel = 8;
      masks.push(mask);
      // A frozen material ignores changes of this kind; it is frozen again
      // when the chunk now being set up is finished.
      materials.get(blend.material)?.material.unfreeze();
      surface.setBlend({ mask, map: blend.map, albedo: layer.albedoTexture, normal: layer.bumpTexture, metres: surfaceExtras(layer).metres ?? 2 });
      blended.add(blend);
    }
  }

  /**
   * Freezes the map's own materials. An unfrozen material is asked before
   * every draw, every frame, whether anything about it has changed (which
   * lights, which textures, fog, instancing...) and works out the answer from
   * scratch; in a town that is about a millisecond a frame spent confirming
   * that nothing has. A frozen one is asked once per mesh. The price: a
   * change to a frozen material that needs a different shader (a texture
   * added or removed, alpha mode, a plugin switched on) is ignored until it is
   * unfrozen. Colours, texture offsets and plugin values such as wind still
   * update. Materials supplied by the game (`options.materials`) are left alone.
   */
  function freezeMaterials(): void {
    for (const shared of materials.values()) {
      if (!supplied.has(shared.material) && !shared.material.isFrozen) shared.material.freeze();
    }
  }

  function surfaceExtras(material: Material): SurfaceExtras {
    return (material.metadata as { gltf?: { extras?: SurfaceExtras } } | null)?.gltf?.extras ?? {};
  }

  /**
   * Frees the materials nothing draws with any more, and their textures. Not
   * while a file is loading: it may just have been handed one of them.
   */
  function dropUnusedMaterials(): void {
    if (activeLoads > 0) return;
    for (const [name, shared] of materials) {
      if (shared.users > 0) continue;
      materials.delete(name);
      shared.material.dispose(false, true);
    }
  }

  /**
   * How pooled meshes are drawn. Each placing could be its own Babylon
   * instance, but an instance is a mesh as far as the scene is concerned:
   * found, culled and copied into a buffer every frame, in the main view and
   * again in every shadow cascade. A thousand trees, plants and window
   * frames cost several milliseconds a frame that way, on the CPU, which is
   * what limits the frame rate on WebGPU. Nothing in a map moves, so instead
   * each pooled mesh carries one fixed list of placings (Babylon's "thin
   * instances") covering every loaded chunk, rebuilt only when a chunk
   * arrives or leaves. The GPU then draws all of them, in view or not; it has
   * the time to spare, and the detail distance bounds how many there are.
   */
  interface Batch {
    /** The placings each loaded chunk contributes, as 16 numbers apiece. */
    parts: Map<number, Float32Array>;
    casting: boolean;
    /** The mesh's own extent. Once it has a list of placings, Babylon's idea of its bounds covers all of them. */
    min: Vector3;
    max: Vector3;
  }
  const batches = new Map<Mesh, Batch>();
  const groupCentre = new Vector3();
  let nextBatchPart = 1;
  function rebuildBatch(source: Mesh): void {
    const batch = batches.get(source);
    if (!batch || source.isDisposed()) return;
    let length = 0;
    for (const part of batch.parts.values()) length += part.length;
    if (length === 0) {
      source.thinInstanceSetBuffer("matrix", null);
      source.thinInstanceSetBuffer("previousMatrix", null);
      source.isVisible = false; // with no list at all it would be drawn once, at the origin
      setCasterGroups(source, null);
      return;
    }
    const all = new Float32Array(length);
    // For the shadow pass: where each chunk's placings are, as a sphere, and
    // how big one placing is. The batch's own bounds cover the whole map and
    // say nothing useful (see shadowCulling.ts).
    const own = Math.max(batch.min.length(), batch.max.length()); // reach of the mesh from its own origin
    const world = source.computeWorldMatrix(true);
    const spheres = new Float32Array(batch.parts.size * 4);
    let largest = 0;
    let group = 0;
    let offset = 0;
    for (const part of batch.parts.values()) {
      all.set(part, offset);
      offset += part.length;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      let scale = 0;
      for (let i = 0; i < part.length; i += 16) {
        const x = part[i + 12]!, y = part[i + 13]!, z = part[i + 14]!;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        scale = Math.max(scale, Math.hypot(part[i]!, part[i + 1]!, part[i + 2]!), Math.hypot(part[i + 4]!, part[i + 5]!, part[i + 6]!), Math.hypot(part[i + 8]!, part[i + 9]!, part[i + 10]!));
      }
      Vector3.TransformCoordinatesFromFloatsToRef((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, world, groupCentre);
      spheres[group++] = groupCentre.x;
      spheres[group++] = groupCentre.y;
      spheres[group++] = groupCentre.z;
      spheres[group++] = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + own * scale;
      largest = Math.max(largest, own * scale);
    }
    setCasterGroups(source, { spheres, size: largest });
    source.thinInstanceSetBuffer("matrix", all, 16, true);
    // Where everything was last frame, for motion vectors: the same places.
    // Said explicitly because the copy Babylon otherwise keeps for itself is
    // made once and never resized; when the list grows, WebGPU rejects the
    // write and with it every frame from then on.
    source.thinInstanceSetBuffer("previousMatrix", all, 16, true);
    source.thinInstanceRefreshBoundingInfo();
    source.isVisible = true;
  }

  /**
   * Blender's linked duplicates (the same tree placed 900 times): keep a
   * single copy of each such mesh for the whole map and turn every placement
   * into an instance of it, so all of them — across all loaded chunks — are
   * drawn in one batch. The exporter writes the real mesh once, in the
   * always-loaded file (flagged `library`), which is loaded before any chunk;
   * a chunk carries only a placeholder at each placing. (Maps exported before
   * that carry a full copy per chunk, and the first one seen becomes the source.)
   */
  function poolSharedMeshes(container: AssetContainer): void {
    const extrasOf = (node: TransformNode | null): ObjectExtras | undefined =>
      (node?.metadata as { gltf?: { extras?: ObjectExtras } } | null)?.gltf?.extras;

    const instanceLike = (original: AbstractMesh, source: Mesh): void => {
      const copy = source.createInstance(original.name);
      // An instance takes its bounds from its source, which by now may span
      // every placing on the map. Colliders are sized from these, so give it
      // the mesh's real extent back.
      const batch = batches.get(source);
      if (batch) copy.buildBoundingInfo(batch.min, batch.max);
      copy.parent = original.parent;
      copy.position.copyFrom(original.position);
      copy.scaling.copyFrom(original.scaling);
      if (original.rotationQuaternion) copy.rotationQuaternion = original.rotationQuaternion.clone();
      else copy.rotation.copyFrom(original.rotation);
      copy.metadata = original.metadata;
      // Never drawn: it exists to be measured (colliders, navigation) and is
      // then folded into the pooled mesh's list of placings. Drawn even for a
      // frame, it would make every material it uses compile a second version
      // of its shader, for instances, at a tenth of a second apiece.
      copy.isVisible = false;
      container.meshes.push(copy);
    };
    const forget = (mesh: AbstractMesh): void => {
      const index = container.meshes.indexOf(mesh);
      if (index >= 0) container.meshes.splice(index, 1);
    };

    for (const mesh of [...container.meshes]) {
      if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
      const primitive = /_primitive(\d+)$/.exec(mesh.name);
      const extras = primitive ? extrasOf(mesh.parent as TransformNode | null) : extrasOf(mesh);
      const meshId = extras?.mesh_id;
      if (!meshId) continue;
      const key = `${meshId}:${primitive?.[1] ?? 0}`;

      const pooled = pool.get(key);
      if (pooled) {
        // Seen before: re-point this copy and its instances at the pooled mesh.
        for (const instance of [...mesh.instances]) {
          instanceLike(instance, pooled);
          forget(instance);
          instance.dispose();
        }
        instanceLike(mesh, pooled);
        forget(mesh);
        mesh.dispose();
      } else {
        // First sighting: this mesh becomes the map-wide source. It stays
        // hidden and outlives the chunk; its own placement becomes an instance
        // (unless it is the library's copy, which was never a placement).
        if (!extras?.library) instanceLike(mesh, mesh);
        forget(mesh);
        if (mesh.geometry) {
          const index = container.geometries.indexOf(mesh.geometry);
          if (index >= 0) container.geometries.splice(index, 1);
        }
        mesh.parent = poolRoot;
        mesh.metadata = null;
        mesh.name = `pool:${key}`;
        mesh.isVisible = false;
        mesh.receiveShadows = true;
        pool.set(key, mesh);
        const bounds = mesh.getBoundingInfo();
        batches.set(mesh, { parts: new Map(), casting: false, min: bounds.minimum.clone(), max: bounds.maximum.clone() });
        // It keeps its material for as long as the map lives.
        const shared = mesh.material && materials.get(mesh.material.name);
        if (shared) shared.users++;
      }
    }
  }

  // --- Set-up, a little at a time ----------------------------------------------
  //
  // Turning a file into a working piece of the world (collision shapes above
  // all) takes 20 to 50 ms for a block of houses: three frames' worth, felt as
  // a stutter every time a chunk arrives while running. So it is done one
  // object at a time, a few milliseconds per frame, and one file at a time.
  // The meshes are on screen from the first frame; what trails behind by a few
  // frames is collision and shadows, for something 80 m away.
  //
  // Not while a caller is waiting on `whenLoadedAround` (the loading screen, a
  // teleport): then it runs flat out, because nobody is watching frames.
  const SET_UP_SLICE = 3.5; // ms of set-up per frame
  let hurry = 0; // how many callers are waiting for the world to finish loading
  let settingUp: Promise<void> = Promise.resolve();
  /** Resolves at the start of the next frame (or soon, if nothing is rendering). */
  function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        scene.onBeforeRenderObservable.remove(observer);
        resolve();
      };
      const observer = scene.onBeforeRenderObservable.add(finish);
      const timer = setTimeout(finish, 100);
    });
  }

  async function setUp(container: AssetContainer, detail: boolean, label: string): Promise<Loaded | null> {
    // One file at a time: two arriving together would otherwise share a frame.
    const turn = settingUp;
    let done!: () => void;
    settingUp = new Promise<void>((resolve) => (done = resolve));
    await turn;
    try {
      if (disposed || scene.isDisposed) {
        container.dispose();
        return null;
      }
      return await setUpNow(container, detail, label);
    } finally {
      done();
    }
  }

  async function setUpNow(container: AssetContainer, detail: boolean, label: string): Promise<Loaded | null> {
    let sliceEnds = performance.now() + SET_UP_SLICE;
    /** Waits for the next frame if this one's share is used up. False if the map went away meanwhile. */
    const breathe = async (): Promise<boolean> => {
      if (hurry > 0 || performance.now() <= sliceEnds) return true;
      await nextFrame();
      sliceEnds = performance.now() + SET_UP_SLICE;
      return !(disposed || scene.isDisposed);
    };
    timed("  add to scene", () => container.addAllToScene());
    if (origin.lengthSquared() > 0) {
      for (const node of [...container.meshes, ...container.transformNodes]) if (!node.parent) node.position.addInPlace(origin);
    }
    // Meshes end up with no parent in common (each is baked into place), so
    // hiding a file is hiding each of its meshes. `isVisible` is not used for
    // this: the set-up below switches that on object by object.
    const show = (on: boolean): void => {
      for (const mesh of container.meshes) mesh.setEnabled(on);
    };
    if (!shown) show(false);
    const usedMaterials = timed("  share materials", () => shareMaterials(container));
    timed("  pool meshes", () => poolSharedMeshes(container));

    const shapes: PhysicsShape[] = [];
    const walkable: Mesh[] = [];
    const tagged = new Map<Mesh, ObjectExtras>();
    const obstacles: MapObstacle[] = [];
    const sharedShapes = new Map<string, PhysicsShape>();
    const placings = new Map<Mesh, number[]>(); // pooled mesh -> where this file places it
    const colliders = new PhysicsShapeContainer(scene);
    let colliderCount = 0;
    const addCollider = (shape: PhysicsShape, at?: Vector3, rotation?: Quaternion, scale?: Vector3): void => {
      colliders.addChild(shape, at, rotation, scale);
      colliderCount++;
    };
    const track = (shape: PhysicsShape): PhysicsShape => {
      shape.material = { friction: 0.9, restitution: 0 };
      shapes.push(shape);
      return shape;
    };

    // A Blender object with several materials arrives as a parent node with
    // one child mesh per material; treat that family as one object.
    const objects = new Map<TransformNode, AbstractMesh[]>();
    for (const mesh of container.meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      const parent = mesh.parent;
      const owner =
        parent instanceof TransformNode && parent.name !== "__root__" && /_primitive\d+$/.test(mesh.name) ? parent : mesh;
      const family = objects.get(owner);
      if (family) family.push(mesh);
      else objects.set(owner, [mesh]);
    }

    const scale = new Vector3();
    const rotation = new Quaternion();
    const translation = new Vector3();
    /** The map was disposed half-way through: undo what has been made so far. */
    const abandon = (): null => {
      colliders.dispose();
      for (const shape of shapes) shape.dispose();
      container.dispose();
      for (const shared of usedMaterials) shared.users--;
      return null;
    };

    // Nothing is shown until its turn below has come. A mesh drawn before its
    // transform is baked sits under the file's mirrored root, and a mirrored
    // mesh needs a different version of every shader it uses: two dozen
    // compiles, a tenth of a second each, for a picture nobody would miss.
    for (const mesh of container.meshes) mesh.isVisible = false;

    for (const [owner, meshes] of objects) {
      const extras = ((owner.metadata as { gltf?: { extras?: ObjectExtras } } | null)?.gltf?.extras ?? {}) as ObjectExtras;
      const instanced = meshes.some((m) => m instanceof InstancedMesh || (m instanceof Mesh && m.instances.length > 0));
      const colliderOnly = isTrue(extras.collider_only);
      const collision = detail ? (extras.collision ?? (instanced ? "box" : "mesh")) : "none";

      // A placing of a pooled mesh: used below to work out its collider, then
      // folded into that mesh's list of placings and discarded.
      const placing = meshes.every((m) => m instanceof InstancedMesh && batches.has(m.sourceMesh));
      const casts = detail && extras.shadows !== false && extras.shadows !== 0;
      for (const mesh of meshes) {
        if (mesh instanceof Mesh) mesh.receiveShadows = true;
        if (colliderOnly) mesh.isVisible = false;
        else if (casts && !placing) lighting.addShadowCaster(mesh, false);
      }

      // glTF content sits under a mirrored root (right-handed file, left-handed
      // engine). Physics wants a proper rotation, so fold the mirror into the
      // shape instead: `placement` is the object's transform without it.
      const world = owner.computeWorldMatrix(true);
      const mirrored = world.determinant() < 0;
      const placement = mirrored ? MIRROR_X.multiply(world) : world;
      placement.decompose(scale, rotation, translation);

      if (collision === "box" || collision === "sphere" || collision === "cylinder") {
        // Bounds in the object's own space, so a rotated wall gets a snug box.
        const lo = new Vector3(Infinity, Infinity, Infinity);
        const hi = new Vector3(-Infinity, -Infinity, -Infinity);
        for (const mesh of meshes) {
          const box = mesh.getBoundingInfo().boundingBox;
          lo.minimizeInPlace(box.minimum);
          hi.maximizeInPlace(box.maximum);
        }
        if (mirrored) [lo.x, hi.x] = [-hi.x, -lo.x];
        lo.multiplyInPlace(scale);
        hi.multiplyInPlace(scale);
        const centre = lo.add(hi).scaleInPlace(0.5);
        const size = hi.subtract(lo);
        const radiusScale = Math.max(scale.x, scale.z);

        if (collision === "box") {
          addCollider(track(new PhysicsShapeBox(centre, Quaternion.Identity(), size, scene)), translation, rotation);
        } else if (collision === "sphere") {
          const radius = extras.collision_radius ? extras.collision_radius * radiusScale : Math.max(size.x, size.y, size.z) / 2;
          addCollider(track(new PhysicsShapeSphere(centre, radius, scene)), translation, rotation);
        } else {
          const radius = extras.collision_radius ? extras.collision_radius * radiusScale : Math.min(size.x, size.z) / 2;
          const bottom = new Vector3(centre.x, lo.y, centre.z);
          const top = new Vector3(centre.x, hi.y, centre.z);
          addCollider(track(new PhysicsShapeCylinder(bottom, top, radius, scene)), translation, rotation);
        }
      }

      if (!instanced) {
        // Unique static geometry: bake its transform into the vertices, so the
        // mesh sits at the origin with no parent and nothing to recompute.
        for (const mesh of meshes) {
          if (!(mesh instanceof Mesh)) continue;
          mesh.setParent(null);
          // The glTF loader gives meshes whose triangle lists are identical
          // (two plain boxes, say) the very same index array. Baking under
          // the mirrored root reverses each triangle in place, so a shared
          // array would be reversed once per mesh, leaving every second one
          // inside-out: lit from the wrong side, which shows as black walls.
          const indices = mesh.getIndices();
          if (indices) mesh.setIndices(indices.slice());
          timed("  bake", () => {
            mesh.bakeCurrentTransformIntoVertices();
            mesh.refreshBoundingInfo(); // the bake moves the vertices but not the culling bounds
          });
          if (mesh.material) supplied.get(mesh.material)?.prepareMesh?.(mesh);
          if (detail) tagged.set(mesh, extras);
          if (collision === "mesh") addCollider(timed("  mesh collider", () => track(new PhysicsShapeMesh(mesh, scene))));
          else if (collision === "convex") addCollider(timed("  hull collider", () => track(new PhysicsShapeConvexHull(mesh, scene))));
          if (collision === "mesh" || collision === "convex") walkable.push(mesh);
          // A block of houses is several meshes, each with a collision shape
          // that takes up to 10 ms to build: pause between those too.
          if (!(await breathe())) return abandon();
        }
      } else if (collision === "mesh" || collision === "convex") {
        // Instances share one collision shape per source mesh, placed per instance.
        for (const mesh of meshes) {
          const source = mesh instanceof InstancedMesh ? mesh.sourceMesh : (mesh as Mesh);
          const key = `${source.uniqueId}:${collision}:${mirrored}`;
          let shape = sharedShapes.get(key);
          if (!shape) {
            const positions = Float32Array.from(source.getVerticesData(VertexBuffer.PositionKind) ?? []);
            const indices = Array.from(source.getIndices() ?? []);
            if (mirrored) {
              for (let i = 0; i < positions.length; i += 3) positions[i] = -positions[i]!;
              for (let i = 0; i < indices.length; i += 3) [indices[i], indices[i + 1]] = [indices[i + 1]!, indices[i]!];
            }
            const hull = new Mesh("colliderSource", scene);
            hull.setVerticesData(VertexBuffer.PositionKind, positions);
            hull.setIndices(indices);
            shape = track(collision === "mesh" ? new PhysicsShapeMesh(hull, scene) : new PhysicsShapeConvexHull(hull, scene));
            hull.dispose();
            sharedShapes.set(key, shape);
          }
          addCollider(shape, translation.clone(), rotation.clone(), scale.clone());
        }
      }

      for (const mesh of meshes) {
        mesh.freezeWorldMatrix();
        mesh.doNotSyncBoundingInfo = true;
      }

      // Everything collided with as a simple shape, or as an instance, is
      // summarised as an upright cylinder for navigation.
      const baked = !instanced && (collision === "mesh" || collision === "convex");
      if (collision !== "none" && !baked) {
        const lo = new Vector3(Infinity, Infinity, Infinity);
        const hi = new Vector3(-Infinity, -Infinity, -Infinity);
        for (const mesh of meshes) {
          const box = mesh.getBoundingInfo().boundingBox;
          lo.minimizeInPlace(box.minimumWorld);
          hi.maximizeInPlace(box.maximumWorld);
        }
        const footprint = Math.min(hi.x - lo.x, hi.z - lo.z) / 2;
        const radius =
          extras.collision_radius && collision !== "box" ? extras.collision_radius * Math.max(scale.x, scale.z) : footprint;
        obstacles.push({
          position: new Vector3((lo.x + hi.x) / 2, lo.y, (lo.z + hi.z) / 2),
          radius,
          height: hi.y - lo.y,
        });
      }

      if (!placing && !colliderOnly) for (const mesh of meshes) mesh.isVisible = true;

      if (placing) {
        for (const mesh of meshes as InstancedMesh[]) {
          const source = mesh.sourceMesh;
          const batch = batches.get(source)!;
          // Where this placing stands, as seen from the pooled mesh (which has a mirrored parent of its own).
          const relative = mesh.computeWorldMatrix(true).multiply(Matrix.Invert(source.computeWorldMatrix(true)));
          let list = placings.get(source);
          if (!list) placings.set(source, (list = []));
          for (let i = 0; i < 16; i++) list.push(relative.m[i]!);
          // One list per mesh, so shadows are all or nothing: the mesh casts if any placing of it does.
          if (casts && !batch.casting) {
            batch.casting = true;
            lighting.addShadowCaster(source, false);
          }
          const index = container.meshes.indexOf(mesh);
          if (index >= 0) container.meshes.splice(index, 1);
          mesh.dispose();
        }
      }

      // Out of time for this frame: carry on in the next one.
      if (!(await breathe())) return abandon();
    }
    const batchPart = nextBatchPart++;
    timed("  rebuild batches", () => {
      for (const [source, list] of placings) {
        batches.get(source)!.parts.set(batchPart, new Float32Array(list));
        rebuildBatch(source);
      }
    });

    freezeMaterials();
    if (!shown) show(false); // again: the set-up made meshes of its own

    // One static body carries every collider in the chunk.
    let colliderNode: TransformNode | null = null;
    let body: PhysicsBody | null = null;
    if (colliderCount > 0) {
      colliderNode = new TransformNode(`${label}:colliders`, scene);
      const node = colliderNode;
      body = timed("  physics body", () => {
        const made = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
        made.shape = colliders;
        return made;
      });
    }

    return {
      level: detail ? "detail" : "far",
      triangles: 0,
      walkable,
      tagged,
      obstacles,
      show,
      dispose() {
        body?.dispose();
        colliders.dispose();
        for (const shape of shapes) shape.dispose();
        colliderNode?.dispose();
        container.dispose();
        for (const source of placings.keys()) {
          batches.get(source)?.parts.delete(batchPart);
          if (!disposed) rebuildBatch(source);
        }
        for (const shared of usedMaterials) shared.users--;
      },
    };
  }

  // --- Streaming ---------------------------------------------------------------

  function distanceTo(info: MapChunk, point: Vector3): number {
    const dx = Math.max(info.min[0] - point.x, 0, point.x - info.max[0]);
    const dz = Math.max(info.min[2] - point.z, 0, point.z - info.max[2]);
    return Math.hypot(dx, dz);
  }

  function lodFor(info: MapChunk, level: Level): MapLod {
    return level === "far" && info.lods[1] ? info.lods[1] : info.lods[0]!;
  }

  async function load(chunk: ChunkState, level: Exclude<Level, "none">): Promise<void> {
    chunk.loading = level;
    activeLoads++;
    try {
      const lod = lodFor(chunk.info, level);
      const container = await loadFile(lod.file);
      if (disposed || scene.isDisposed) {
        container.dispose();
        return;
      }
      if (chunk.want !== level) {
        container.dispose(); // the camera moved on while this was downloading
        return;
      }
      const loaded = await setUp(container, level === "detail", `chunk:${chunk.info.id}`);
      if (!loaded) return; // the map went away while this was being set up
      loaded.triangles = lod.triangles;
      const hadDetail = chunk.loaded?.level === "detail";
      timed("chunk unload", () => chunk.loaded?.dispose()); // swap only once the replacement is in, so there's never a hole
      chunk.loaded = loaded;
      if (hadDetail || level === "detail") onDetailChanged.notifyObservers();
    } catch (error) {
      chunk.failed = true;
      console.error(`Failed to load map chunk ${chunk.info.id}:`, error);
    } finally {
      chunk.loading = "none";
      activeLoads--;
    }
  }

  function update(): void {
    if (disposed) return;
    const focus = held ?? camera.globalPosition;
    const queue: ChunkState[] = [];

    for (const chunk of chunks) {
      let distance = distanceTo(chunk.info, focus);
      for (const pin of pins) distance = Math.min(distance, distanceTo(chunk.info, pin));
      chunk.distance = distance;

      const current = chunk.loaded?.level ?? "none";
      if (distance <= detailDistance || (current === "detail" && distance <= detailDistance + hysteresis)) {
        chunk.want = "detail";
      } else if (distance <= viewDistance || (current !== "none" && distance <= viewDistance + hysteresis)) {
        chunk.want = "far";
      } else {
        chunk.want = "none";
      }

      if (chunk.want === "none") {
        const hadDetail = chunk.loaded?.level === "detail";
        chunk.loaded?.dispose();
        chunk.loaded = null;
        if (hadDetail) onDetailChanged.notifyObservers();
      } else if (chunk.want !== current && chunk.loading === "none" && !chunk.failed) {
        queue.push(chunk);
      }
    }

    // Nearest first, and full-detail chunks (the ones you can fall through) before scenery.
    queue.sort((a, b) => Number(b.want === "detail") - Number(a.want === "detail") || a.distance - b.distance);
    for (const chunk of queue) {
      if (activeLoads >= maxConcurrentLoads) break;
      void load(chunk, chunk.want as Exclude<Level, "none">).then(update);
    }

    // Hold movable bodies still wherever the ground has no collision right now.
    for (const [body, held] of anchored) {
      if (body.transformNode.isDisposed()) {
        anchored.delete(body);
        continue;
      }
      const at = body.transformNode.absolutePosition;
      const grounded = chunks.some(
        ({ info, loaded }) =>
          loaded?.level === "detail" && at.x >= info.min[0] && at.x <= info.max[0] && at.z >= info.min[2] && at.z <= info.max[2],
      );
      if (grounded === held) {
        body.setMotionType(grounded ? PhysicsMotionType.DYNAMIC : PhysicsMotionType.STATIC);
        anchored.set(body, !grounded);
      }
    }

    dropUnusedMaterials();
    for (const resolve of waiters.splice(0)) resolve();
  }

  // Re-evaluate a few times a second; chunk loads also trigger it as they finish.
  let frame = 0;
  const observer = scene.onBeforeRenderObservable.add(() => {
    if (frame++ % 10 === 0) update();
  });

  // Objects flagged always_loaded (water, distant landmarks).
  let globalContent: Loaded | null = null;
  if (manifest.global) {
    activeLoads++;
    try {
      hurry++;
      globalContent = await setUp(await loadFile(manifest.global.file), true, "global");
    } finally {
      hurry--;
      activeLoads--;
    }
  }
  update();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scene.onBeforeRenderObservable.remove(observer);
    for (const chunk of chunks) chunk.loaded?.dispose();
    globalContent?.dispose();
    poolRoot.dispose(); // and with it every pooled mesh
    for (const { material } of materials.values()) {
      if (!supplied.has(material)) material.dispose(false, true);
    }
    variation?.dispose();
    for (const mask of masks) mask.dispose();
    materials.clear();
    for (const resolve of waiters.splice(0)) resolve();
    onDetailChanged.clear();
  }
  scene.onDisposeObservable.addOnce(dispose);

  return {
    manifest,
    baseUrl,
    get detailDistance() {
      return detailDistance;
    },
    set detailDistance(value: number) {
      detailDistance = value;
      update();
    },
    get viewDistance() {
      return viewDistance;
    },
    set viewDistance(value: number) {
      viewDistance = value;
      applyFog();
      update();
    },
    get stats(): MapStats {
      const stats: MapStats = { detailed: 0, far: 0, loading: activeLoads, total: chunks.length, triangles: 0 };
      for (const chunk of chunks) {
        if (!chunk.loaded) continue;
        if (chunk.loaded.level === "detail") stats.detailed++;
        else stats.far++;
        stats.triangles += chunk.loaded.triangles;
      }
      return stats;
    },
    marker: (name) => manifest.markers.find((m) => m.name === name),
    async whenLoadedAround(position, radius = detailDistance) {
      const pin = position.clone();
      pins.add(pin);
      hurry++;
      try {
        for (;;) {
          update();
          const pending = chunks.some(
            (chunk) =>
              !chunk.failed &&
              distanceTo(chunk.info, pin) <= Math.min(radius, detailDistance) &&
              chunk.loaded?.level !== "detail",
          );
          if (!pending || disposed) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      } finally {
        hurry--;
        // Keep the area loaded a little longer, so whoever is about to move
        // the camera there has time to do it.
        setTimeout(() => pins.delete(pin), 2000);
      }
    },
    hold(point) {
      held = point ? point.clone() : null;
      update();
    },
    get shown() {
      return shown;
    },
    set shown(on: boolean) {
      if (on === shown) return;
      shown = on;
      poolRoot.setEnabled(on); // and with it every batch of pooled meshes
      globalContent?.show(on);
      for (const chunk of chunks) chunk.loaded?.show(on);
    },
    anchor(body) {
      anchored.set(body, false);
    },
    onDetailChanged,
    collisionGeometry() {
      const meshes: Mesh[] = [];
      const obstacles: MapObstacle[] = [];
      for (const content of [globalContent, ...chunks.map((chunk) => chunk.loaded)]) {
        if (content?.level !== "detail") continue;
        meshes.push(...content.walkable);
        obstacles.push(...content.obstacles);
      }
      return { meshes, obstacles };
    },
    meshesWith(property) {
      const found: { mesh: Mesh; value: string | number | boolean }[] = [];
      for (const content of [globalContent, ...chunks.map((chunk) => chunk.loaded)]) {
        if (content?.level !== "detail") continue;
        for (const [mesh, extras] of content.tagged) {
          const value = (extras as Record<string, unknown>)[property];
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") found.push({ mesh, value });
        }
      }
      return found;
    },
    dispose,
  };
}
