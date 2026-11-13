import { CreateNavigationPluginAsync } from "@babylonjs/addons/navigation/factory/factory.single-thread";
import type { RecastJSCrowd } from "@babylonjs/addons/navigation/plugin/RecastJSCrowd";
import type { IAgentParametersV2 } from "@babylonjs/addons/navigation/types";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Observable } from "@babylonjs/core/Misc/observable";
import type { Mesh } from "@babylonjs/core";
import * as Recast from "@recast-navigation/core";
import * as RecastGenerators from "@recast-navigation/generators";
import type { GameContext } from "./context";
import { timed } from "./perf";
import type { MapObstacle } from "./map";

/**
 * AI navigation: works out where characters can walk, finds paths, and moves a
 * crowd of agents along them while they avoid each other.
 *
 * This is a thin layer over Babylon's navigation add-on
 * (`@babylonjs/addons/navigation`), which wraps Recast/Detour compiled to
 * WebAssembly. The add-on supplies the queries, the crowd and the debug mesh.
 * The one thing done differently is building. The add-on builds a whole
 * navmesh in one blocking call (its worker version is unfinished and not
 * exported in 9.36), which would freeze the game for the best part of a second
 * every time the streamed map changes. So the navmesh here is a grid of square
 * tiles on a fixed world-wide grid, built a few per frame with the same Recast
 * generator, and only where the geometry actually changed. Agents keep walking
 * while tiles are swapped underneath them.
 */

export interface NavigationOptions {
  /** How close an agent's centre may get to walls and drops, in metres. */
  agentRadius?: number;
  /** Agents fit under anything at least this far above the ground. */
  agentHeight?: number;
  /** Tallest ledge walked up without jumping. Matches the player's `stepHeight`. */
  maxStep?: number;
  /** Steepest walkable slope, in degrees. */
  maxSlope?: number;
  /**
   * Horizontal resolution of the navmesh, in metres. Smaller follows walls
   * more closely and fits through narrower gaps, at a quadratic cost in build
   * time. Half the agent radius is the usual choice. Stairs are only walkable
   * if each tread is deeper than two cells (and each riser at most `maxStep`);
   * shallower ones look like a slope too steep to walk.
   */
  cellSize?: number;
  /**
   * Side of one navmesh tile, in metres: an eighth of a map chunk by default.
   * A tile is built in one go, so smaller tiles keep each frame's share of the
   * work short; larger ones waste less on the overlap between neighbours.
   */
  tileSize?: number;
  /** Milliseconds per frame given to building tiles. The last tile started may run a millisecond or two over. */
  frameBudget?: number;
  /** Capacity of the crowd. */
  maxAgents?: number;
}

export const DEFAULT_NAVIGATION_OPTIONS: Readonly<Required<NavigationOptions>> = {
  agentRadius: 0.25,
  agentHeight: 0.6,
  maxStep: 0.18,
  maxSlope: 45,
  cellSize: 0.125,
  // Small tiles and a small budget: a tile in a built-up street takes several
  // milliseconds at 8 m, and at least one is built per frame while there is
  // work, so big tiles mean every frame of a rebuild runs long.
  tileSize: 6,
  frameBudget: 1.5,
  maxAgents: 64,
};

/** The static world, as handed over by `map.collisionGeometry()` and `level.statics`. */
export interface NavigationSources {
  /** Anything walkable or in the way. Transforms are respected; the meshes are not modified. */
  meshes: Mesh[];
  /** Upright cylinders to walk around (trees, pillars, rocks). */
  obstacles?: MapObstacle[];
}

export interface NavAgentOptions {
  /** Top speed in m/s. */
  speed?: number;
  /** How quickly it reaches that speed, in m/s². */
  acceleration?: number;
  radius?: number;
  height?: number;
}

/** A character driven along the navmesh. Position your model from `position` each frame. */
export interface NavAgent {
  /**
   * The agent's feet, on the navmesh. Updated every frame; the same object
   * throughout. The navmesh is an approximation that floats a few centimetres
   * above the real ground (up to 10 cm or so on slopes): for a model to stand
   * exactly on the ground, cast a short ray down through this point, as
   * `game/npcs.ts` does.
   */
  readonly position: Vector3;
  /** Metres per second. Zero when standing. */
  readonly velocity: Vector3;
  /** Top speed in m/s. Can be changed at any time. */
  speed: number;
  /** Walks to the navmesh point nearest `target`. False if there is no navmesh near it. */
  goTo(target: Vector3): boolean;
  /** Forgets the destination and slows to a halt. */
  stop(): void;
  /** Moves instantly, dropping any destination. */
  teleport(position: Vector3): void;
  remove(): void;
}

export interface Navigation {
  /**
   * True once the first build has finished. Before that the navmesh is partly
   * there (it fills in outward from the camera): queries may find nothing, and
   * agents wait until there is ground under them.
   */
  readonly ready: boolean;
  /** Fires each time the navmesh has caught up with the latest `rebuild`. */
  readonly onRebuilt: Observable<void>;
  /**
   * Makes the navmesh match `sources`. Only tiles whose geometry changed are
   * rebuilt, a few per frame and nearest the camera first, so call it whenever
   * the world changes; calls in quick succession are merged and the latest
   * sources win. Resolves when the navmesh is up to date. There is no need to
   * wait for that, but it is safe to, even while loading: when the scene is
   * not being rendered, building carries on from a timer.
   *
   * Meshes are identified by their `uniqueId`: to change a mesh's shape, pass
   * a new mesh rather than editing its vertices.
   */
  rebuild(sources: NavigationSources): Promise<void>;
  /** Corner points of the shortest path, including both ends. Empty if there is none. */
  findPath(from: Vector3, to: Vector3): Vector3[];
  /** The navmesh point nearest `position`, or null if there is none within a couple of metres. */
  closestPoint(position: Vector3): Vector3 | null;
  /** A random point that can be walked to from `center`, roughly within `radius`. */
  randomPointAround(center: Vector3, radius: number): Vector3 | null;
  /** Adds an agent at the navmesh point nearest `start`. Works before the navmesh exists: the agent waits. */
  addAgent(start: Vector3, options?: NavAgentOptions): NavAgent;
  /** Draws the navmesh. Redrawing it after each rebuild is slow; leave it off outside debugging. */
  showDebug(visible: boolean): void;
  dispose(): void;
}

/** Sides of the ring of walls that stands in for a cylinder obstacle. */
const OBSTACLE_SIDES = 8;
/** The ring's corners sit this much further out than the cylinder's radius, so its sides clear the cylinder. */
const OBSTACLE_RING = 1 / Math.cos(Math.PI / OBSTACLE_SIDES);
/** Rebuild requests wait this long (ms) for more to arrive: the map reports chunk changes in bursts. */
const REBUILD_SETTLE_TIME = 200;
/** No frame for this long (ms) means the scene is not being rendered: it is still loading, or the tab is hidden. */
const NOT_RENDERING_AFTER = 250;
/** Milliseconds of building at a time while the scene is not being rendered and there are no frames to hold up. */
const OFFSCREEN_BUDGET = 16;
/** How far (m) from a position queries look for the navmesh: sideways, and up or down. */
const QUERY_REACH = new Vector3(2, 4, 2);
/**
 * Detour packs a tile number and a polygon number into each polygon id, 22
 * bits between them. This split allows 4096 tiles (a 384 m square of the
 * default 6 m tiles) with up to 1024 polygons each.
 */
const TILE_BITS = 12;
/** Voxels per `maxStep`: fine enough to tell a ledge that can be stepped up from one that can't. */
const STEP_CELLS = 6;
/** Detour crowd steering: anticipate turns, avoid and keep apart from other agents, and keep straightening the path. */
const AGENT_UPDATE_FLAGS = 1 | 2 | 4 | 8 | 16;

interface Tile {
  x: number;
  y: number;
  /** Changes when the geometry in or just around the tile does. */
  fingerprint: number;
  minY: number;
  maxY: number;
  /** The triangles in or just around the tile, as three vertex numbers each. Only filled in while the tile waits to be built. */
  triangles: number[];
}

/** One pass of bringing the navmesh up to date. */
interface BuildJob {
  /** World-space corners of every triangle the queued tiles need, in Recast's memory. */
  vertices: Recast.FloatArray;
  /** Nearest to the camera last, so `pop()` takes it first. */
  queue: Tile[];
}

/** Something that shapes the navmesh, with its world bounds and a number that identifies it. */
interface Piece {
  min: Vector3;
  max: Vector3;
  hash: number;
  mesh?: Mesh;
  obstacle?: MapObstacle;
}

/**
 * Creates the navigation system for a scene. It starts empty; call `rebuild`
 * with the world's static geometry. Cleans up with the scene.
 */
export async function createNavigation(ctx: GameContext, options: NavigationOptions = {}): Promise<Navigation> {
  const { scene, camera, clock } = ctx;
  const settings = { ...DEFAULT_NAVIGATION_OPTIONS, ...options };

  // The WebAssembly module is loaded once per page and shared by every scene.
  await Recast.init();
  const plugin = await CreateNavigationPluginAsync({ instance: { ...Recast, ...RecastGenerators } });

  // --- Build settings --------------------------------------------------------
  // Recast works on a voxel grid: `cs` is a cell's width, `ch` its height, and
  // most other settings are counted in cells.
  const cs = settings.cellSize;
  const ch = settings.maxStep / STEP_CELLS;
  const cellsPerTile = Math.max(8, Math.round(settings.tileSize / cs));
  const tileSize = cellsPerTile * cs;
  const { config } = RecastGenerators.buildTiledNavMeshRcConfig({
    recastConfig: {
      ...Recast.recastConfigDefaults,
      cs,
      ch,
      tileSize: cellsPerTile,
      walkableSlopeAngle: settings.maxSlope,
      walkableHeight: Math.ceil(settings.agentHeight / ch),
      walkableClimb: STEP_CELLS,
      walkableRadius: Math.ceil(settings.agentRadius / cs),
      maxEdgeLen: 12 / cs, // 12 m, in cells
      // How far (in `ch`) the navmesh surface may stray from the voxels it was
      // made from. Following them exactly (1) nearly doubles the build time.
      detailSampleMaxError: 3,
    },
    navMeshBounds: [
      [0, 0, 0],
      [tileSize, 1, tileSize],
    ], // unused: tiles are placed on a world-wide grid instead
  });
  /** Gap between an obstacle's walls and its lid: enough voxels that Recast keeps them apart. */
  const lidGap = ch * 3;
  /** A tile is shaped by geometry up to this far outside it, so that neighbouring tiles agree along their shared edge. */
  const tileMargin = config.borderSize * cs;
  const buildContext = new Recast.RecastBuildContext(false);

  // An empty navmesh whose tile grid is anchored at the world origin and goes
  // on in every direction, so tiles can come and go as the map streams. The
  // plugin takes a navmesh in its saved form.
  const empty = new Recast.NavMesh();
  empty.initTiled(
    Recast.NavMeshParams.create({
      orig: { x: 0, y: 0, z: 0 },
      tileWidth: tileSize,
      tileHeight: tileSize,
      maxTiles: 1 << TILE_BITS,
      maxPolys: 1 << (22 - TILE_BITS),
    }),
  );
  plugin.buildFromNavmeshData(Recast.exportNavMesh(empty));
  empty.destroy();
  const navMesh = plugin.navMesh!;
  const query = plugin.navMeshQuery;
  plugin.setDefaultQueryExtent(QUERY_REACH);

  // The add-on's crowd steps itself by real time. Switch that off and step it
  // by game time instead (see the frame observer below), so pausing stops it.
  plugin.timeFactor = 0;
  // (The second argument is the largest agent radius the crowd is laid out for.)
  const crowd = plugin.createCrowd(settings.maxAgents, settings.agentRadius * 2, scene) as RecastJSCrowd;

  // --- State -------------------------------------------------------------------
  /** The tiles built so far (those with nothing walkable included), by `tileKey`. */
  const built = new Map<number, Tile>();
  const tileKey = (x: number, y: number): number => (x + 0x8000) * 0x10000 + (y + 0x8000);
  /** How many rings of walls, one agent radius apart, fill an obstacle whose outer ring has this radius. */
  const ringCount = (radius: number): number => Math.max(1, Math.ceil(radius / settings.agentRadius - 0.5));
  const agents = new Set<{ recover(): void; update(): void; remove(): void }>();
  const onRebuilt = new Observable<void>();
  let ready = false;
  let disposed = false;
  let job: BuildJob | null = null;
  /** The latest `rebuild` request not yet started, and when the first of its burst arrived. */
  let requested: NavigationSources | null = null;
  let requestedAt = 0;
  /** `rebuild` callers to tell when the navmesh is up to date. */
  const waiting: Array<() => void> = [];
  let warnedFull = false;
  let lastFrameAt = 0;
  let offscreenTimer: ReturnType<typeof setTimeout> | undefined;
  let debugVisible = false;
  let debugMesh: Mesh | null = null;
  let debugMaterial: StandardMaterial | null = null;

  // --- Building ----------------------------------------------------------------

  /**
   * Works out which tiles are out of date and collects the triangles each of
   * them needs. The work is in proportion to what changed: when one map chunk
   * loads, only it and its neighbours are read.
   */
  function startJob(sources: NavigationSources): void {
    freeJob();
    const tiles = new Map<number, Tile>();
    /** Calls `visit` for each tile that something spanning `min` to `max` can shape. */
    const eachTile = (minX: number, minZ: number, maxX: number, maxZ: number, visit: (tile: Tile) => void): void => {
      const lastX = Math.floor((maxX + tileMargin) / tileSize);
      const lastY = Math.floor((maxZ + tileMargin) / tileSize);
      for (let x = Math.floor((minX - tileMargin) / tileSize); x <= lastX; x++) {
        for (let y = Math.floor((minZ - tileMargin) / tileSize); y <= lastY; y++) {
          const key = tileKey(x, y);
          let tile = tiles.get(key);
          if (!tile) tiles.set(key, (tile = { x, y, fingerprint: 0, minY: Infinity, maxY: -Infinity, triangles: [] }));
          visit(tile);
        }
      }
    };

    // 1. What is the world made of, and which tiles does each piece touch?
    const pieces: Piece[] = [];
    let vertexCount = 0;
    for (const mesh of sources.meshes) {
      if (mesh.isDisposed() || mesh.getTotalIndices() === 0) continue;
      mesh.computeWorldMatrix(true);
      const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
      pieces.push({ min, max, hash: Math.imul(mesh.uniqueId + 1, 0x9e3779b1) ^ mesh.getTotalIndices(), mesh });
      vertexCount += mesh.getTotalVertices();
    }
    for (const obstacle of sources.obstacles ?? []) {
      // Obstacles become rings of walls with a lid (see step 3), from below the base to just above the top.
      const { position, radius, height } = obstacle;
      const reach = radius * OBSTACLE_RING;
      const min = new Vector3(position.x - reach, position.y - radius, position.z - reach);
      const max = new Vector3(position.x + reach, position.y + height + lidGap, position.z + reach);
      const hash = Math.imul(position.x * 1000, 73856093) ^ Math.imul(position.z * 1000, 19349663) ^ Math.imul((radius + height) * 1000, 83492791);
      pieces.push({ min, max, hash, obstacle });
      vertexCount += OBSTACLE_SIDES * (2 * ringCount(reach) + 1);
    }
    for (const { min, max, hash } of pieces) {
      eachTile(min.x, min.z, max.x, max.z, (tile) => {
        tile.fingerprint = (tile.fingerprint + hash) | 0; // a sum, so the order pieces arrive in doesn't matter
        tile.minY = Math.min(tile.minY, min.y);
        tile.maxY = Math.max(tile.maxY, max.y);
      });
    }

    // 2. Tiles the world no longer reaches go at once (removing one is cheap);
    //    tiles whose surroundings changed are queued, nearest the camera first.
    for (const [key, tile] of built) {
      if (tiles.has(key)) continue;
      navMesh.removeTile(navMesh.getTileRefAt(tile.x, tile.y, 0));
      built.delete(key);
    }
    const stale = new Set<Tile>();
    for (const [key, tile] of tiles) if (built.get(key)?.fingerprint !== tile.fingerprint) stale.add(tile);
    if (stale.size === 0) return finishJob();
    const distance = (tile: Tile): number => Math.hypot((tile.x + 0.5) * tileSize - camera.position.x, (tile.y + 0.5) * tileSize - camera.position.z);
    const queue = [...stale].sort((a, b) => distance(b) - distance(a));

    // 3. Hand each stale tile the triangles in and around it.
    const positions = new Float32Array(vertexCount * 3);
    let v = 0; // vertices written so far
    let a = 0;
    let b = 0;
    let c = 0;
    const addTriangle = (tile: Tile): void => {
      if (stale.has(tile)) tile.triangles.push(a, b, c);
    };
    // Recast wants floors wound counter-clockwise seen from above. Babylon's
    // own meshes are wound the other way; glTF meshes already match (the
    // loader records the difference in `sideOrientation`), unless they sit
    // under a mirroring transform, which reverses whichever they had.
    const nativeWinding = scene.useRightHandedSystem ? Material.ClockWiseSideOrientation : Material.CounterClockWiseSideOrientation;
    const point = new Vector3();

    for (const { min, max, mesh, obstacle } of pieces) {
      let needed = false;
      eachTile(min.x, min.z, max.x, max.z, (tile) => (needed ||= stale.has(tile)));
      if (!needed) continue;

      if (mesh) {
        const data = mesh.getVerticesData(VertexBuffer.PositionKind);
        const indices = mesh.getIndices();
        if (!data || !indices) continue;
        const world = mesh.getWorldMatrix();
        if (world.isIdentity()) {
          positions.set(data, v * 3); // already in world space, like the map's baked meshes
        } else {
          for (let p = 0; p < data.length; p += 3) {
            Vector3.TransformCoordinatesFromFloatsToRef(data[p]!, data[p + 1]!, data[p + 2]!, world, point);
            point.toArray(positions, v * 3 + p);
          }
        }
        const reverse = ((mesh.material?.sideOrientation ?? mesh.sideOrientation) === nativeWinding) !== world.determinant() < 0;
        for (let t = 0; t < indices.length; t += 3) {
          a = indices[t]! + v;
          b = indices[reverse ? t + 2 : t + 1]! + v;
          c = indices[reverse ? t + 1 : t + 2]! + v;
          const ax = positions[a * 3]!, az = positions[a * 3 + 2]!;
          const bx = positions[b * 3]!, bz = positions[b * 3 + 2]!;
          const cx = positions[c * 3]!, cz = positions[c * 3 + 2]!;
          eachTile(Math.min(ax, bx, cx), Math.min(az, bz, cz), Math.max(ax, bx, cx), Math.max(az, bz, cz), addTriangle);
        }
        v += data.length / 3;
      } else if (obstacle) {
        // Walls are never walkable, whichever way they face, and the ground
        // they stand on is blocked with them. One ring goes around the
        // cylinder; wide obstacles get more inside it, too close together for
        // an agent to fit between, so no walkable island is left in the middle.
        const { position, radius } = obstacle;
        const reach = radius * OBSTACLE_RING;
        const corner = (ring: number, side: number, y: number): void => {
          const angle = (side / OBSTACLE_SIDES) * Math.PI * 2;
          const distance = reach - ring * settings.agentRadius;
          positions.set([position.x + Math.cos(angle) * distance, y, position.z + Math.sin(angle) * distance], v++ * 3);
        };
        const triangles: number[] = [];
        for (let ring = 0; ring < ringCount(reach); ring++) {
          for (let side = 0; side < OBSTACLE_SIDES; side++) {
            const here = v;
            const next = side + 1 < OBSTACLE_SIDES ? v + 2 : v + 2 - OBSTACLE_SIDES * 2;
            triangles.push(here, next, here + 1, next, next + 1, here + 1);
            corner(ring, side, min.y);
            corner(ring, side, max.y - lidGap);
          }
        }
        // A lid facing down, just clear of the walls. Where Recast merges a
        // wall with the ground under it, it can take the wall's top for
        // floor; with a lid this close above, nothing fits there.
        for (let side = 0; side < OBSTACLE_SIDES; side++) {
          if (side >= 2) triangles.push(v - side, v - 1, v);
          corner(0, side, max.y);
        }
        eachTile(min.x, min.z, max.x, max.z, (tile) => {
          if (stale.has(tile)) for (const index of triangles) tile.triangles.push(index);
        });
      }
    }

    const vertices = new Recast.VerticesArray();
    vertices.copy(positions.subarray(0, v * 3));
    job = { vertices, queue };
  }

  function buildTile(current: BuildJob, tile: Tile): void {
    let data: Recast.UnsignedCharArray | undefined;
    if (tile.triangles.length > 0) {
      const triangles = new Recast.TrianglesArray();
      triangles.copy(tile.triangles);
      // Recast's generator wants its own spatial index over the triangles, even for this few.
      const index = new Recast.RecastChunkyTriMesh();
      index.init(current.vertices, triangles, tile.triangles.length / 3, 256);
      const result = RecastGenerators.generateTileNavMeshData(
        current.vertices,
        triangles,
        config,
        index,
        {
          x: tile.x,
          y: tile.y,
          bmin: [tile.x * tileSize, tile.minY, tile.y * tileSize],
          bmax: [(tile.x + 1) * tileSize, tile.maxY, (tile.y + 1) * tileSize],
        },
        {},
        false,
        buildContext,
      );
      if (result.success) data = result.data; // failure just means nothing here is walkable

      // The generator hands back its working data and keeps a log; nothing
      // here needs either. (recast-navigation 0.43 also loses about 2 KB of
      // scratch memory inside each call, which nothing out here can free;
      // 0.44 fixes that.)
      const { heightfield, compactHeightfield, contourSet, polyMesh, polyMeshDetail } = result.intermediates;
      if (heightfield) Recast.freeHeightfield(heightfield);
      if (compactHeightfield) Recast.freeCompactHeightfield(compactHeightfield);
      if (contourSet) Recast.freeContourSet(contourSet);
      if (polyMesh) Recast.freePolyMesh(polyMesh);
      if (polyMeshDetail) Recast.freePolyMeshDetail(polyMeshDetail);
      buildContext.resetLog();
      Recast.Raw.destroy(index.raw);
      triangles.destroy();
      tile.triangles = [];
    }

    // Swap the tile in place. The crowd moves agents standing on the old one
    // onto the new one, and they carry on.
    navMesh.removeTile(navMesh.getTileRefAt(tile.x, tile.y, 0));
    if (data) {
      const { status } = navMesh.addTile(data, Recast.Detour.DT_TILE_FREE_DATA, 0);
      if (Recast.statusFailed(status)) {
        data.destroy();
        if (!warnedFull) console.warn(`Navigation: could not add a tile (${Recast.statusToReadableString(status)}). The loaded world may need more than ${1 << TILE_BITS} tiles; use a larger tileSize.`);
        warnedFull = true;
      }
    }
    built.set(tileKey(tile.x, tile.y), tile);
  }

  /** Builds queued tiles until `budget` milliseconds have passed. Always builds at least one. */
  function buildTiles(budget: number): void {
    if (!job) return;
    const deadline = performance.now() + budget;
    do {
      const tile = job.queue.pop();
      if (!tile) break;
      buildTile(job, tile);
    } while (performance.now() < deadline);
    for (const agent of agents) agent.recover(); // there may be ground now under agents that had none
    if (job.queue.length === 0) finishJob();
  }

  function freeJob(): void {
    job?.vertices.destroy();
    job = null;
  }

  function finishJob(): void {
    freeJob();
    ready = true;
    refreshDebugMesh();
    onRebuilt.notifyObservers();
    if (requested) return; // a newer request is waiting its turn; callers are told when that one is done
    for (const resolve of waiting.splice(0)) resolve();
  }

  // --- Debug view -------------------------------------------------------------

  function refreshDebugMesh(): void {
    debugMesh?.dispose();
    debugMesh = null;
    if (!debugVisible || built.size === 0) return;
    if (!debugMaterial) {
      debugMaterial = new StandardMaterial("navmesh-debug", scene);
      debugMaterial.emissiveColor = new Color3(0.05, 0.3, 0.7);
      debugMaterial.disableLighting = true;
      debugMaterial.alpha = 0.3;
      debugMaterial.backFaceCulling = false;
      debugMaterial.zOffset = -2; // drawn just in front of the ground it lies on
    }
    debugMesh = plugin.createDebugNavMesh(scene);
    debugMesh.material = debugMaterial;
    debugMesh.isPickable = false;
  }

  // --- Queries ----------------------------------------------------------------

  function closestPoint(position: Vector3): Vector3 | null {
    const { success, polyRef, point } = query.findClosestPoint(position);
    return success && polyRef !== 0 ? new Vector3(point.x, point.y, point.z) : null;
  }

  // --- Agents -----------------------------------------------------------------

  function addAgent(start: Vector3, agentOptions: NavAgentOptions = {}): NavAgent {
    const radius = agentOptions.radius ?? settings.agentRadius;
    const parameters: IAgentParametersV2 = {
      radius,
      height: agentOptions.height ?? settings.agentHeight,
      maxSpeed: agentOptions.speed ?? 2,
      maxAcceleration: agentOptions.acceleration ?? 8,
      collisionQueryRange: radius * 12, // how far it looks ahead for walls and other agents
      pathOptimizationRange: radius * 30,
      separationWeight: 2,
      updateFlags: AGENT_UPDATE_FLAGS,
      obstacleAvoidanceType: 0,
      queryFilterType: 0,
      userData: 0,
    };
    // The add-on's crowd keeps a node at each agent's position.
    const node = new TransformNode("nav-agent", scene);
    const position = closestPoint(start) ?? start.clone();
    const velocity = Vector3.Zero();
    const id = crowd.addAgent(position, parameters, node);
    /** Where the agent has been told to go, kept in case it loses its footing on the way (see `recover`). */
    let target: Vector3 | null = null;
    let removed = false;

    const agent = {
      position,
      velocity,
      get speed() {
        return parameters.maxSpeed;
      },
      set speed(value: number) {
        if (value === parameters.maxSpeed || removed) return;
        parameters.maxSpeed = value;
        crowd.updateAgentParameters(id, parameters);
      },
      goTo(destination: Vector3): boolean {
        const reachable = removed ? null : closestPoint(destination);
        if (!reachable) return false;
        target = reachable;
        crowd.agentGoto(id, reachable);
        return true;
      },
      stop(): void {
        target = null;
        if (!removed) crowd.recastCrowd.getAgent(id)?.resetMoveTarget();
      },
      teleport(destination: Vector3): void {
        if (removed) return;
        target = null;
        position.copyFrom(closestPoint(destination) ?? destination);
        velocity.setAll(0);
        crowd.agentTeleport(id, position);
      },
      remove(): void {
        if (removed) return;
        removed = true;
        agents.delete(agent);
        if (!disposed) crowd.removeAgent(id);
        node.dispose();
      },
      /**
       * An agent with no navmesh under it (not built yet, or unloaded with its
       * map chunk) stands where it is. Once there is ground there again it
       * steps back on and takes up its errand.
       */
      recover(): void {
        if (crowd.getAgentState(id) !== 0) return; // 0 is Detour's "not on the navmesh"
        const ground = closestPoint(position);
        if (!ground) return;
        crowd.agentTeleport(id, ground);
        if (target) crowd.agentGoto(id, target);
      },
      update(): void {
        crowd.getAgentPositionToRef(id, position);
        if (crowd.getAgentState(id) === 0) velocity.setAll(0); // not on the navmesh: the crowd has stopped moving it
        else crowd.getAgentVelocityToRef(id, velocity);
      },
    };
    agents.add(agent);
    return agent;
  }

  // --- Every frame ------------------------------------------------------------

  /** Spends up to `budget` milliseconds on bringing the navmesh up to date. */
  function work(budget: number): void {
    if (requested && performance.now() - requestedAt >= REBUILD_SETTLE_TIME) {
      const sources = requested;
      requested = null;
      startJob(sources); // planning takes a few milliseconds itself; tiles start on the next call
    } else {
      buildTiles(budget);
    }
  }

  const frameObserver = scene.onBeforeRenderObservable.add(() => {
    lastFrameAt = performance.now();
    timed("navigation", () => work(settings.frameBudget));

    const dt = clock.delta;
    if (dt <= 0) return; // paused
    crowd.update(dt);
    for (const agent of agents) agent.update();
  });

  /**
   * Building is paced by the frame loop. While the scene is not being rendered
   * there is no frame loop (and nothing on screen to stall), so this timer
   * does the work instead, in longer slices. It runs only while there is work.
   */
  function workOffscreen(): void {
    offscreenTimer = undefined;
    if (disposed || (!job && !requested)) return;
    const rendering = performance.now() - lastFrameAt < NOT_RENDERING_AFTER;
    if (!rendering) work(OFFSCREEN_BUDGET);
    offscreenTimer = setTimeout(workOffscreen, rendering ? NOT_RENDERING_AFTER : 0);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    scene.onBeforeRenderObservable.remove(frameObserver);
    clearTimeout(offscreenTimer);
    freeJob();
    for (const agent of [...agents]) agent.remove();
    debugMesh?.dispose();
    debugMaterial?.dispose();
    plugin.dispose(); // the crowd, the navmesh and its query
    Recast.Raw.destroy(config);
    Recast.Raw.destroy(buildContext.raw);
    onRebuilt.clear();
    for (const resolve of waiting.splice(0)) resolve();
  }
  scene.onDisposeObservable.addOnce(dispose);

  return {
    get ready() {
      return ready;
    },
    onRebuilt,
    rebuild(sources) {
      if (disposed) return Promise.resolve();
      if (!requested) requestedAt = performance.now();
      requested = sources;
      offscreenTimer ??= setTimeout(workOffscreen, 0);
      return new Promise((resolve) => waiting.push(resolve));
    },
    findPath(from, to) {
      const { success, path } = query.computePath(from, to);
      return success ? path.map((p) => new Vector3(p.x, p.y, p.z)) : [];
    },
    closestPoint,
    randomPointAround(center, radius) {
      const { success, randomPolyRef, randomPoint } = query.findRandomPointAroundCircle(center, radius);
      return success && randomPolyRef !== 0 ? new Vector3(randomPoint.x, randomPoint.y, randomPoint.z) : null;
    },
    addAgent,
    showDebug(visible) {
      debugVisible = visible;
      refreshDebugMesh();
    },
    dispose,
  };
}
