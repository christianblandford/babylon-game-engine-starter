/**
 * Project-wide tunables. Quality presets trade visual fidelity for frame rate;
 * pick one with `?quality=low|medium|high|ultra` or from the debug panel.
 */

import { getSettings } from "./engine/settings";

import type { Environment } from "./engine/spaces";

export type QualityLevel = "low" | "medium" | "high" | "ultra";

export interface QualitySettings {
  level: QualityLevel;
  /** Cap on device pixel ratio. Retina at full resolution is the #1 GPU cost. */
  maxPixelRatio: number;
  /** MSAA sample count for the HDR pipeline (1 = off). */
  msaaSamples: number;
  fxaa: boolean;
  bloom: boolean;
  ssao: boolean;
  ssaoSamples: number;
  /**
   * Temporal anti-aliasing: smooths edges (and SSAO noise) by blending each
   * frame with the previous ones. Needs the depth/motion pass that SSAO brings,
   * so it only takes effect on presets with `ssao`. Replaces FXAA there.
   */
  taa: boolean;
  /** Resolution of each shadow cascade. */
  shadowMapSize: number;
  shadowCascades: number;
  /** How far from the camera shadows are drawn, in metres. */
  shadowDistance: number;
  /** Cube size of the sky-derived image-based-lighting probe. */
  iblSize: number;
  /** How far streamed map chunks are kept loaded, in metres. Fog hides the edge. */
  viewDistance: number;
  /** Particle density multiplier for busy effects (smoke, rain, bursts). */
  particles: number;
  /** How thickly grass is planted, as a multiplier. 0 turns ground cover off. */
  groundCover: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: {
    level: "low", maxPixelRatio: 1, msaaSamples: 1, fxaa: true, bloom: false,
    ssao: false, ssaoSamples: 8, taa: false, shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 40, iblSize: 64, viewDistance: 220, particles: 0.4, groundCover: 0,
  },
  medium: {
    level: "medium", maxPixelRatio: 1.25, msaaSamples: 1, fxaa: true, bloom: true,
    ssao: false, ssaoSamples: 8, taa: false, shadowMapSize: 1024, shadowCascades: 3, shadowDistance: 60, iblSize: 128, viewDistance: 300, particles: 0.7, groundCover: 0.5,
  },
  high: {
    level: "high", maxPixelRatio: 1.5, msaaSamples: 4, fxaa: true, bloom: true,
    ssao: true, ssaoSamples: 8, taa: true, shadowMapSize: 2048, shadowCascades: 4, shadowDistance: 80, iblSize: 256, viewDistance: 400, particles: 1, groundCover: 1,
  },
  ultra: {
    level: "ultra", maxPixelRatio: 2, msaaSamples: 4, fxaa: true, bloom: true,
    ssao: true, ssaoSamples: 16, taa: true, shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 120, iblSize: 256, viewDistance: 600, particles: 1, groundCover: 1.4,
  },
};

function isQualityLevel(v: string | null): v is QualityLevel {
  return v !== null && v in QUALITY_PRESETS;
}

/** Resolves the active preset: a `?quality=` URL param wins, then the player's saved setting. */
export function getQuality(): QualitySettings {
  const fromUrl = new URLSearchParams(location.search).get("quality");
  return QUALITY_PRESETS[isQualityLevel(fromUrl) ? fromUrl : getSettings().quality];
}

/** Static asset URLs (files live in /public). */
export const ASSETS = {
  fox: "/assets/models/Fox.glb",
} as const;

/** A playable level. Add yours here and it appears in the level menu. */
export interface LevelInfo {
  id: string;
  name: string;
  /** Streamed world exported from Blender (`npm run map:export`), or null for the empty flat test ground. */
  map: string | null;
  /** False leaves out the scaffold's demo props (platform, stairs, crates, balls) that otherwise stand around the origin. */
  demoProps?: boolean;
  /** How far (m) the map loads at full detail. Default: one and a half chunks. */
  detailDistance?: number;
  /** Where the sun is, as a direction pointing toward it (x, up, z). Default: the scaffold's mid-morning sun. */
  sunDirection?: [number, number, number];
  /**
   * Markers to look around from while the loading screen is up, so the
   * shaders for what is there are compiled before play starts. The first
   * sight of a kind of surface costs a tenth of a second or more; a town seen
   * for the first time at a run is a second of freezes. Name a spot in the
   * middle of anything the player doesn't start within sight of.
   */
  warmUp?: string[];
  /** The light in this place, as shares of the scene's own: see `Environment` in engine/spaces.ts. */
  environment?: Partial<Environment>;
  /**
   * The insides of things in this level: a hall, a shop, a cellar. Each is
   * its own small map, reached through a door (a Blender Empty with
   * `door = "<its id>#<marker>"`), loaded beside the level as the player
   * walks up and entered behind a short fade, with no loading screen
   * (engine/spaces.ts). By convention its files live inside the level's own
   * folder, under `interiors/<id>/`. `?level=<level id>/<id>` starts inside
   * one, which is how to work on it.
   */
  interiors?: InteriorInfo[];
  /** Set on the level made up for starting inside an interior: it is lit as one. */
  indoors?: boolean;
}

/** The inside of something in a level. See `LevelInfo.interiors`. */
export interface InteriorInfo {
  /**
   * Unique within its level. Doors name it: `door = "hall#entrance"`. The
   * list is flat, because places joined by doors are a web, not a tree (a
   * cave can open into the hall's cellar *and* onto the hillside); where one
   * place plainly belongs to another, say so in the id, as a path:
   * `hall/cellar`, `caves/upper`, with its files under `interiors/hall/cellar/`.
   */
  id: string;
  name: string;
  map: string;
  /** Its light, as shares of the level's own, over `INDOORS` in engine/spaces.ts. */
  environment?: Partial<Environment>;
}

export const LEVELS: LevelInfo[] = [
  {
    id: "town",
    name: "Test Town",
    map: "/maps/test_town/map.json",
    demoProps: false,
    detailDistance: 80,
    sunDirection: [0.45, 0.6, 0.66],
    warmUp: ["town_gate", "poi_square", "poi_hall", "poi_duck_pond", "poi_pond", "poi_farm"],
    // The inside of the hall, entered through its door.
    interiors: [{ id: "hall", name: "Town Hall", map: "/maps/test_town/interiors/hall/map.json" }],
  },
  { id: "island", name: "Test Island", map: "/maps/test_island/map.json", warmUp: ["spawn_pier", "poi_summit"] },
  { id: "flat", name: "Flat Ground", map: null },
];

/**
 * Looks a level up by id. "town" is a level; "town/hall" is the interior
 * `hall` of the level `town`, returned as a level of its own (the same sun,
 * lit as a room) for starting inside it.
 */
export function findLevel(id: string | null): LevelInfo | undefined {
  if (!id) return undefined;
  const cut = id.indexOf("/");
  const [levelId, interiorId] = cut < 0 ? [id, ""] : [id.slice(0, cut), id.slice(cut + 1)];
  const level = LEVELS.find((candidate) => candidate.id === levelId);
  if (!level || !interiorId) return level;
  const interior = level.interiors?.find((candidate) => candidate.id === interiorId);
  return interior && { id, name: interior.name, map: interior.map, demoProps: false, sunDirection: level.sunDirection, environment: interior.environment, indoors: true };
}
