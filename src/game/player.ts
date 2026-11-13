/**
 * Player character: a physics capsule you can drive in first or third person,
 * with an animated fox as the visible body.
 *
 * Each frame runs in three phases, each on its own scene observable:
 *
 *   1. readInput    (before animations) look, zoom, view toggle, jump presses
 *   2. stepPhysics  (after physics)     move the capsule through the world
 *   3. present      (before render)     place the camera, turn and animate the fox
 *
 * The scene has one gameplay camera (`ctx.camera`) and both view modes drive
 * it: the camera always sits `cameraDistance` behind a pivot on the character,
 * looking along the view direction. First person is simply distance zero, so
 * switching modes is a smooth zoom rather than a cut.
 */

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Observable } from "@babylonjs/core/Misc/observable";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult";
import { CharacterSupportedState, PhysicsCharacterController } from "@babylonjs/core/Physics/v2/characterController";
import type { AnimationGroup, CharacterSurfaceInfo, FreeCamera, HavokPlugin, IRaycastQuery, Observer, PhysicsBody, PhysicsEngineV2, Scene } from "@babylonjs/core";
import { ASSETS } from "../config";
import { spawnModel, type ModelInstance } from "../engine/assets";
import type { GameClock } from "../engine/clock";
import type { GameContext } from "../engine/context";
import type { Input } from "../engine/input";

export type ViewMode = "first" | "third";

/** Every field is optional; see `DEFAULT_PLAYER_OPTIONS` for the defaults. */
export interface PlayerOptions {
  /** Where the character's feet start, in world space. Default: the origin. */
  position?: Vector3;
  /** Initial view direction around the Y axis, in radians (0 looks along +Z). */
  yaw?: number;
  /** Initial view pitch in radians (positive looks down). */
  pitch?: number;
  viewMode?: ViewMode;

  // --- Movement ---------------------------------------------------------
  /** Ground speed in m/s. */
  walkSpeed?: number;
  /** Ground speed in m/s while "sprint" is held. */
  runSpeed?: number;
  /** Height of a jump's apex above the take-off point, in metres. */
  jumpHeight?: number;
  /** How fast velocity catches up with the stick on the ground, per second. Higher is snappier. */
  groundResponse?: number;
  /** The same in the air. Low values give floaty jumps you can only nudge. */
  airResponse?: number;
  /** Seconds after walking off a ledge during which a jump still works. */
  coyoteTime?: number;
  /** Seconds a jump press is remembered, so pressing just before landing still jumps. */
  jumpBufferTime?: number;
  /** Steepest slope that counts as ground, in degrees. Steeper ones are slid down. */
  maxSlopeDegrees?: number;
  /**
   * How far the ground may fall away in one step before the character counts
   * as airborne, in metres. This is what keeps it glued to the floor when
   * running over a crest or down stairs instead of skipping off the top.
   */
  groundStickDistance?: number;
  /**
   * Tallest ledge, in metres, that is walked up or down without jumping:
   * stairs, kerbs, door sills. Anything taller is a wall on the way up and a
   * drop on the way down. Size it to the character: about a quarter of its
   * height looks natural (0.18 for this 0.7 m fox, 0.4 for a human). 0 turns
   * stepping off.
   */
  stepHeight?: number;
  /** `onLand` only fires for impacts at least this fast (m/s), so stairs and kerbs stay quiet. 2.5 is a 30 cm drop. */
  minLandSpeed?: number;

  // --- Swimming ----------------------------------------------------------
  /**
   * Where the water is: the height of its surface at a position, or null
   * where there is none (`waterSurface(...)` from engine/water.ts). Without
   * this the character never swims. It starts swimming by itself once the
   * water is deep enough to float in, and walks again when its feet find
   * ground shallower than that.
   */
  waterLevel?: ((position: Vector3) => number | null) | null;
  /** How much of the character is under water while it floats: metres from the feet up to the waterline. */
  floatDepth?: number;
  /** Swimming speed as a fraction of the walking or running speed. */
  swimSpeed?: number;

  // --- Collision capsule ------------------------------------------------
  /** Total capsule height in metres. Keep `eyeHeight` and `thirdPersonPivotHeight` below it. */
  capsuleHeight?: number;
  /**
   * Capsule radius in metres. Its rounded bottom rolls over ledges up to about
   * `capsuleRadius * (1 - cos(maxSlopeDegrees))` high (10 cm with the defaults).
   * Anything taller is a wall: jump it, or give stairs a ramp-shaped collider.
   */
  capsuleRadius?: number;
  /**
   * Thin cushion of air, in metres, the capsule keeps between itself and
   * everything it touches so it never starts a step already inside a wall.
   * Smaller hugs the ground more exactly; larger forgives rougher geometry.
   */
  skinWidth?: number;

  // --- Look -------------------------------------------------------------
  /** Radians of rotation per pixel of mouse movement. */
  mouseSensitivity?: number;
  /** Radians per second at full right-stick deflection. */
  stickLookSpeed?: number;
  /** Flip vertical look (push forward to look down). */
  invertY?: boolean;
  /** How far up or down the view can tilt, in radians. Must stay below PI / 2. */
  maxPitch?: number;

  // --- First person -----------------------------------------------------
  /** Camera height above the feet, in metres. */
  eyeHeight?: number;

  // --- Third person -----------------------------------------------------
  /** Height above the feet of the point the camera orbits, in metres. */
  thirdPersonPivotHeight?: number;
  /** Initial camera distance from the pivot, in metres. */
  thirdPersonDistance?: number;
  /** Closest the wheel zooms before switching to first person. */
  thirdPersonMinDistance?: number;
  thirdPersonMaxDistance?: number;
  /** Fraction the distance changes per wheel notch. */
  zoomStep?: number;
  /** Clearance the camera keeps from walls and floors, in metres. Should exceed the camera's `minZ`. */
  cameraCollisionRadius?: number;
  /** How fast the character turns to face where it is going, per second. */
  turnResponse?: number;

  // --- Model ------------------------------------------------------------
  /** Height the character model is scaled to, in metres. */
  modelHeight?: number;
}

export const DEFAULT_PLAYER_OPTIONS: Readonly<Required<Omit<PlayerOptions, "position">>> = {
  yaw: 0,
  pitch: 0.2,
  viewMode: "third",

  walkSpeed: 1.8,
  runSpeed: 4.5,
  jumpHeight: 0.8,
  groundResponse: 14,
  airResponse: 2.5,
  coyoteTime: 0.1,
  jumpBufferTime: 0.12,
  maxSlopeDegrees: 50,
  groundStickDistance: 0.05,
  stepHeight: 0.18,
  minLandSpeed: 2.5,

  waterLevel: null,
  floatDepth: 0.42,
  swimSpeed: 0.55,

  capsuleHeight: 0.8,
  capsuleRadius: 0.3,
  skinWidth: 0.02,

  mouseSensitivity: 0.0025,
  stickLookSpeed: 2.6,
  invertY: false,
  maxPitch: 1.45,

  eyeHeight: 0.6,

  thirdPersonPivotHeight: 0.75,
  thirdPersonDistance: 4,
  thirdPersonMinDistance: 1.5,
  thirdPersonMaxDistance: 10,
  zoomStep: 0.15,
  cameraCollisionRadius: 0.2,
  turnResponse: 12,

  modelHeight: 0.7,
};

export interface Player {
  /** Sits at the character's feet; `rotation.y` is the direction it faces. Parent things to this. */
  readonly root: TransformNode;
  /** Feet position in world space. Read only: use `teleport` to move the character. */
  readonly position: Vector3;
  /** Current velocity in m/s. Read only. */
  readonly velocity: Vector3;
  readonly isGrounded: boolean;
  readonly isSwimming: boolean;
  /** Fires on entering the water (true, with the speed it was hit at in m/s) and on leaving it (false). */
  readonly onSwimChanged: Observable<{ swimming: boolean; speed: number }>;
  /** The character's physics body: what trigger zones and collision events report. */
  readonly body: PhysicsBody | null;
  readonly viewMode: ViewMode;
  setViewMode(mode: ViewMode): void;
  readonly onViewModeChanged: Observable<ViewMode>;
  /** Fires on take-off. */
  readonly onJump: Observable<void>;
  /** Fires on touchdown with the downward impact speed in m/s. */
  readonly onLand: Observable<number>;
  /** Moves the character instantly and stops it. `feetPosition` is where the feet end up; `yaw`, if given, is which way it then faces and looks. */
  teleport(feetPosition: Vector3, yaw?: number): void;
  /** Changes look settings on the fly (from a settings menu, say). */
  configure(options: Pick<PlayerOptions, "mouseSensitivity" | "stickLookSpeed" | "invertY">): void;
  /** Removes the character from the scene. Also happens automatically when the scene is disposed. */
  dispose(): void;
}

/**
 * Everything specific to the character model. To use a different model, change
 * this block; nothing else in the file knows it is a fox.
 */
const MODEL = {
  url: ASSETS.fox,
  /** Names of the looping clips in the file. A missing clip is simply skipped. */
  clips: { idle: "Survey", walk: "Walk", run: "Run", air: null as string | null, swim: null as string | null },
  /**
   * Swimming. If the model has a swim clip, name it in `clips.swim`. The fox
   * has none, so it paddles with its run cycle, slowed to these playback
   * rates when treading water and when swimming flat out.
   */
  paddleRates: [0.5, 0.85] as const,
  /**
   * The airborne pose. If the model has a jump/fall clip, name it in
   * `clips.air` above and this is ignored. The fox has none, so the pose is
   * borrowed from the run cycle: this is the point in that cycle (0 to 1) to
   * hold while off the ground, chosen where the legs are stretched mid-leap.
   */
  airPoseInRun: 0.35,
  /**
   * Roughly the ground speed each clip was animated for, in the file's own
   * units per second at playback rate 1 (estimated from how fast the paws
   * travel backwards while planted). Playing a clip at `actual speed / clip
   * speed` keeps the feet from visibly sliding.
   */
  walkClipSpeed: 120,
  runClipSpeed: 220,
  /**
   * Extra yaw (radians) that makes the model face +Z, Babylon's "forward" for a
   * node with `rotation.y = 0`. The fox's nose points along glTF +Z. In a
   * left-handed scene the glTF loader converts handedness by mirroring X (its
   * `__root__` node is a 180 degree Y turn plus a Z scale of -1), which leaves
   * +Z alone, and in a right-handed scene it changes nothing. Either way the
   * fox already faces forward, so no correction is needed.
   */
  yawOffset: 0,
};

/** Longest step simulated at once, so a frame hitch cannot fling the player through a wall. */
const MAX_DT = 1 / 20;
/** Moving away from the ground faster than this (m/s) counts as having left it. */
const LIFT_OFF_SPEED = 0.2;
/** A ledge is stepped onto when it is within this distance (m) beyond the next frame's travel. */
const STEP_TRIGGER_MARGIN = 0.06;
/** How far past a ledge's lip (m) the capsule is placed, so its rounded base rests on the tread rather than the lip. */
const STEP_FORWARD_PROBE = 0.1;
/** Less clear space than this (m) above a ledge means it is a wall, not a step. */
const STEP_MIN_FORWARD = 0.04;
/** Rises smaller than this (m) are left to the capsule's rounded base. */
const STEP_MIN_RISE = 0.03;
/** How fast the camera and model ease down after the capsule drops off a step, per second. */
const STEP_SMOOTH_RESPONSE = 12;
/** How fast the camera distance eases toward its target (zoom, mode switches, backing off a wall), per second. */
const CAMERA_DISTANCE_RESPONSE = 10;
/** The model is hidden while the camera is closer than this to the pivot, so you never see inside it. */
const HIDE_MODEL_DISTANCE = 0.5;
/** Scrolling in past this fraction of the minimum third-person distance switches to first person. */
const FIRST_PERSON_ZOOM_THRESHOLD = 0.9;
/** How fast animation weights ease toward their targets, per second. */
const ANIMATION_BLEND_RESPONSE = 10;
/** Time off the ground (s) before the airborne pose starts, so stairs and kerbs don't flicker into it. */
const AIR_POSE_DELAY = 0.1;
/** How long after being placed somewhere the character may settle onto the ground in silence (s). */
const ARRIVAL_GRACE = 0.6;
/** How far the body pitches with vertical speed while airborne: radians per m/s, and the most it will tilt. */
const AIR_TILT_PER_SPEED = 0.07;
const AIR_TILT_MAX = 0.45;
/** Swimming starts this much (m) deeper than it stops, so the water's edge doesn't flicker between the two. */
const SWIM_ENTER_MARGIN = 0.03;
const SWIM_EXIT_MARGIN = 0.06;
/** How fast buoyancy brings the character to its floating height, per second, and the most it will rise or sink (m/s). */
const BUOYANCY_RESPONSE = 5;
const BUOYANCY_MAX_SPEED = 1.6;
/** How fast water slows the character to its swimming pace, per second. */
const WATER_DRAG = 4;
/** Moving up faster than this (m/s), the character is jumping out of the water, not in it. */
const SWIM_LEAVE_SPEED = 0.6;
/** How the body rides the water: nose up by this much (radians), bobbing by up to about this much (m). */
const SWIM_TILT = -0.14;
const SWIM_BOB = 0.035;
/** Limits on clip playback rate when matching the legs to ground speed. */
const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 2.5;

/** This file assumes a Y-up world. Gravity itself is read from the physics engine. */
const UP = Vector3.Up();
const DOWN = Vector3.Down();

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Fraction of the gap to a target to close this frame so that easing behaves
 * the same at any frame rate. `rate` is "per second": 10 closes most of the gap
 * in about a quarter of a second.
 */
function easing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Wraps an angle to -PI..PI. */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/** The movement state machine from Babylon's character controller example. */
type MoveState = "IN_AIR" | "ON_GROUND" | "START_JUMP" | "SWIMMING";

interface Clip {
  group: AnimationGroup | undefined;
  weight: number;
  /** True for a pose held still (a clip frozen at one frame) rather than played. */
  held?: boolean;
}

/**
 * Creates the player in `ctx.scene`, which must already have Havok physics
 * enabled, and takes over `ctx.camera`.
 */
export async function createPlayer(ctx: GameContext, options: PlayerOptions = {}): Promise<Player> {
  const model = await spawnModel(ctx.scene, MODEL.url, "player-model");
  if (ctx.scene.isDisposed) {
    model.dispose();
    throw new Error("The scene was disposed while the player model was loading.");
  }
  return new PlayerController(ctx, model, options);
}

class PlayerController implements Player {
  readonly root: TransformNode;
  readonly onViewModeChanged = new Observable<ViewMode>();
  readonly onJump = new Observable<void>();
  readonly onLand = new Observable<number>();
  readonly onSwimChanged = new Observable<{ swimming: boolean; speed: number }>();
  readonly body: PhysicsBody | null;

  private readonly settings: Required<PlayerOptions>;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly input: Input;
  private readonly clock: GameClock;
  private readonly physics: PhysicsEngineV2;
  private readonly controller: PhysicsCharacterController;
  private readonly observers: Observer<Scene>[];
  /** +1 in Babylon's default left-handed scenes, -1 in right-handed ones, where screen-right is mirrored. */
  private readonly handedness: number;
  /**
   * How far the feet are below the capsule's centre. The capsule rides about
   * one `skinWidth` above the ground, so the feet are that much lower than its
   * bottom; without this the model would visibly float.
   */
  private readonly feetOffset: number;
  private disposed = false;

  // View
  private mode: ViewMode;
  private yaw: number;
  private pitch: number;
  /** Third-person distance the player has zoomed to. */
  private zoomDistance: number;
  /** Where the camera actually is: eased, shortened by walls, and 0 in first person. */
  private cameraDistance: number;

  // Movement
  private state: MoveState = "IN_AIR";
  private jumpBuffer = 0;
  private coyote = 0;
  /** Downward speed during the most recent airborne step, reported by `onLand`. */
  private fallSpeed = 0;
  /**
   * Seconds left in which touching down is an arrival, not a landing. The
   * character is put a hand's breadth above the ground when it is spawned or
   * teleported, and settles: that must not thump, raise dust, splash or
   * strike the falling pose. Still in the air when this runs out, it really
   * was dropped from a height, and lands as usual. A jump ends it at once.
   */
  private arriving = ARRIVAL_GRACE;
  /** The water's surface height where the character is, while it is in water deep enough to matter. */
  private waterSurface = 0;
  /** 0 on land, 1 afloat: eases between, for the bob and the body's tilt. */
  private afloat = 0;
  private swimTime = 0;
  /** How fast the legs should look like they are going, in m/s. Drives the animation. */
  private groundSpeed = 0;
  /** Direction the body faces, radians about Y. */
  private facing: number;
  /**
   * How far the visuals trail the capsule, in world space. Stepping moves the
   * capsule instantly (up and a little forward); the model and camera ease
   * after it, so stairs read as a climb rather than a series of jumps.
   */
  private readonly stepLag = new Vector3();
  /** True while the capsule waits on a ledge for the visuals to walk up to it. */
  private holding = false;
  /** Speed (m/s) at which the visuals close the gap: the pace the player is asking for. */
  private pace = 0;
  /** Set by a step taken this frame, so its lag isn't shortened until the next one. */
  private steppedThisFrame = false;
  /** Set when the visuals arrive, so the capsule sets off again at full pace instead of accelerating from rest. */
  private resumePace = false;
  private modelRestY = 0;

  // Model
  private readonly modelScale: number;
  private readonly idle: Clip;
  private readonly walk: Clip;
  private readonly run: Clip;
  private readonly air: Clip;
  private readonly swim: Clip;
  /** Seconds since the feet last touched the ground. */
  private airTime = 0;
  private airTilt = 0;

  // Scratch objects reused every frame to keep the garbage collector quiet.
  private readonly support: CharacterSurfaceInfo = {
    isSurfaceDynamic: false,
    supportedState: CharacterSupportedState.UNSUPPORTED,
    averageSurfaceNormal: Vector3.Up(),
    averageSurfaceVelocity: Vector3.Zero(),
    averageAngularSurfaceVelocity: Vector3.Zero(),
  };
  private readonly rayHit = new PhysicsRaycastResult();
  private readonly rayQuery: IRaycastQuery;
  /** Babylon's `IPhysicsShapeCastQuery`, which the package's main entry point does not export by name. */
  private readonly settleQuery: Parameters<HavokPlugin["shapeCast"]>[0];
  private readonly settleCastIn = new ShapeCastResult();
  private readonly settleCastOut = new ShapeCastResult();
  private readonly zero = Vector3.Zero();
  private readonly forward = new Vector3();
  private readonly desiredVelocity = new Vector3();
  private readonly newVelocity = new Vector3();
  private readonly scratch = new Vector3();
  private readonly pivot = new Vector3();
  private readonly rayEnd = new Vector3();
  private readonly stepProbe = new Vector3();

  constructor(
    ctx: GameContext,
    private readonly model: ModelInstance,
    options: PlayerOptions,
  ) {
    // Explicit `undefined` values must not override defaults, so drop them first.
    const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    const s = (this.settings = { ...DEFAULT_PLAYER_OPTIONS, position: Vector3.Zero(), ...given });

    const scene = (this.scene = ctx.scene);
    this.camera = ctx.camera;
    this.input = ctx.input;
    this.clock = ctx.clock;
    this.handedness = scene.useRightHandedSystem ? -1 : 1;

    const physics = scene.getPhysicsEngine();
    if (!physics || physics.getPluginVersion() !== 2) {
      throw new Error("createPlayer needs Havok (physics v2) enabled on the scene first.");
    }
    this.physics = physics as PhysicsEngineV2;

    // --- Transform at the feet ---
    this.root = new TransformNode("player", scene);
    this.root.position.copyFrom(s.position);
    this.root.rotation.y = this.facing = s.yaw;

    // --- Collision capsule ---
    // The controller's position is the capsule's centre; ours is the feet.
    this.feetOffset = s.capsuleHeight / 2 + s.skinWidth;
    const centre = new Vector3(s.position.x, s.position.y + this.feetOffset, s.position.z);
    this.controller = new PhysicsCharacterController(centre, { capsuleHeight: s.capsuleHeight, capsuleRadius: s.capsuleRadius }, scene);
    this.controller.maxSlopeCosine = Math.cos((s.maxSlopeDegrees * Math.PI) / 180);
    this.controller.keepDistance = s.skinWidth;
    this.controller.keepContactTolerance = s.groundStickDistance;

    // Camera rays must pass through the player's own capsule. The controller
    // keeps its physics body private, so find it by the shape it carries.
    const ownBody = scene.transformNodes.find((node) => node.physicsBody?.shape === this.controller.shape)?.physicsBody;
    this.body = ownBody ?? null;
    this.rayQuery = { ignoreBody: ownBody ?? undefined };
    this.settleQuery = {
      shape: this.controller.shape,
      rotation: Quaternion.Identity(),
      startPosition: new Vector3(),
      endPosition: new Vector3(),
      shouldHitTriggers: false,
      ignoreBody: ownBody ?? undefined,
    };

    // --- Model ---
    // Scale by the model's measured height rather than a hard-coded factor, and
    // stand its lowest point on the ground.
    const bounds = model.root.getHierarchyBoundingVectors();
    const height = bounds.max.y - bounds.min.y;
    this.modelScale = height > 0 && Number.isFinite(height) ? s.modelHeight / height : 1;
    model.root.parent = this.root;
    model.root.scaling.setAll(this.modelScale);
    model.root.position.y = this.modelRestY = -bounds.min.y * this.modelScale;
    model.root.rotation.y = MODEL.yawOffset;
    for (const mesh of model.meshes) ctx.lighting.addShadowCaster(mesh);

    // All three clips loop permanently; only their weights change.
    this.idle = this.startClip(MODEL.clips.idle, 1);
    this.walk = this.startClip(MODEL.clips.walk, 0);
    this.run = this.startClip(MODEL.clips.run, 0);
    this.air = this.startAirClip();
    this.swim = MODEL.clips.swim ? this.startClip(MODEL.clips.swim, 0) : { group: undefined, weight: 0 };

    // --- View ---
    this.mode = s.viewMode;
    this.yaw = s.yaw;
    this.pitch = clamp(s.pitch, -s.maxPitch, s.maxPitch);
    this.zoomDistance = clamp(s.thirdPersonDistance, s.thirdPersonMinDistance, s.thirdPersonMaxDistance);
    this.cameraDistance = this.mode === "third" ? this.zoomDistance : 0;
    // We steer the camera with `rotation`; a quaternion would silently override it.
    this.camera.rotationQuaternion = null;

    this.observers = [
      scene.onBeforeAnimationsObservable.add(() => this.readInput()),
      scene.onAfterPhysicsObservable.add(() => this.stepPhysics()),
      scene.onBeforeRenderObservable.add(() => this.present()),
      scene.onDisposeObservable.add(() => this.dispose()),
    ];
    this.present();
  }

  get position(): Vector3 {
    return this.root.position;
  }

  get velocity(): Vector3 {
    return this.controller.getVelocity();
  }

  get isGrounded(): boolean {
    return this.state === "ON_GROUND";
  }

  get isSwimming(): boolean {
    return this.state === "SWIMMING";
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // Zooming into first person leaves the zoom just under the minimum; coming back starts from it.
    if (mode === "third") this.zoomDistance = Math.max(this.zoomDistance, this.settings.thirdPersonMinDistance);
    this.onViewModeChanged.notifyObservers(mode);
  }

  teleport(feetPosition: Vector3, yaw?: number): void {
    if (yaw !== undefined) {
      this.yaw = yaw;
      this.pitch = 0;
      this.root.rotation.y = this.facing = yaw;
    }
    this.root.position.copyFrom(feetPosition);
    this.controller.setPosition(this.scratch.copyFrom(feetPosition).addInPlaceFromFloats(0, this.feetOffset, 0));
    this.controller.setVelocity(this.zero);
    this.state = "IN_AIR";
    this.fallSpeed = 0;
    this.arriving = ARRIVAL_GRACE;
    this.airTime = 0;
    this.coyote = 0;
    this.groundSpeed = 0;
    this.stepLag.setAll(0);
    this.holding = this.steppedThisFrame = this.resumePace = false;
  }

  configure(options: Pick<PlayerOptions, "mouseSensitivity" | "stickLookSpeed" | "invertY">): void {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) (this.settings as Record<string, unknown>)[key] = value;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Deferred removal: we may be inside one of these observables right now
    // (the scene's dispose, say), and removing mid-notification skips a neighbour.
    for (const observer of this.observers) observer.remove(true);
    // The controller frees Havok objects, which only exist while physics does.
    if (this.scene.getPhysicsEngine()) this.controller.dispose();
    if (this.air.held) this.air.group?.dispose(); // our own copy; the model doesn't know about it
    this.model.dispose();
    this.root.dispose();
    this.onViewModeChanged.clear();
    this.onJump.clear();
    this.onLand.clear();
    this.onSwimChanged.clear();
  }

  // ---------------------------------------------------------------------
  // Phase 1: input
  // ---------------------------------------------------------------------

  private readInput(): void {
    if (this.clock.paused) return; // menus own the mouse and keys while paused
    const s = this.settings;
    const input = this.input;
    const dt = this.frameDt();

    // Mouse movement is a distance this frame; the stick is a rate.
    const turn = input.look.x * s.mouseSensitivity + input.lookStick.x * s.stickLookSpeed * dt;
    const tilt = input.look.y * s.mouseSensitivity + input.lookStick.y * s.stickLookSpeed * dt;
    this.yaw = wrapAngle(this.yaw + turn * this.handedness);
    this.pitch = clamp(this.pitch + (s.invertY ? -tilt : tilt), -s.maxPitch, s.maxPitch);

    if (input.wasPressed("toggleView")) this.setViewMode(this.mode === "first" ? "third" : "first");

    if (input.wheel !== 0) {
      if (this.mode === "first") {
        // Scrolling out of first person lands at the closest third-person distance.
        if (input.wheel > 0) {
          this.zoomDistance = s.thirdPersonMinDistance;
          this.setViewMode("third");
        }
      } else {
        // Multiplicative steps feel even at every distance. The zoom may dip
        // slightly below the minimum (the camera stays at the minimum); dipping
        // far enough means "keep going", which is first person.
        this.zoomDistance = Math.min(this.zoomDistance * Math.pow(1 + s.zoomStep, input.wheel), s.thirdPersonMaxDistance);
        if (this.zoomDistance < s.thirdPersonMinDistance * FIRST_PERSON_ZOOM_THRESHOLD) this.setViewMode("first");
      }
    }

    if (input.wasPressed("jump")) this.jumpBuffer = s.jumpBufferTime;
  }

  // ---------------------------------------------------------------------
  // Phase 2: movement
  // ---------------------------------------------------------------------

  private stepPhysics(): void {
    const dt = this.physicsDt();
    if (dt <= 0) return;

    const controller = this.controller;
    const gravity = this.physics.gravity;

    // What, if anything, are we standing on?
    controller.checkSupportToRef(dt, DOWN, this.support);
    const supported = this.support.supportedState === CharacterSupportedState.SUPPORTED;

    const previous = this.state;
    const inWater = this.deepEnoughToSwim();
    // Leaving the water puts the character back in the ordinary states.
    if (previous === "SWIMMING" && !inWater) this.state = supported ? "ON_GROUND" : "IN_AIR";
    this.state = this.nextState(supported, dt, inWater);
    const arrived = this.arriving > 0; // just placed here: whatever it touches first, it touches quietly
    if (this.state === "ON_GROUND" && previous === "IN_AIR") {
      if (!arrived && this.fallSpeed >= this.settings.minLandSpeed) this.onLand.notifyObservers(this.fallSpeed);
      this.fallSpeed = 0;
    }
    if ((this.state === "SWIMMING") !== (previous === "SWIMMING") && this.state !== "START_JUMP") {
      if (!arrived) this.onSwimChanged.notifyObservers({ swimming: this.state === "SWIMMING", speed: this.fallSpeed });
      this.fallSpeed = 0;
    }
    // Runs out with time, not on first touching ground: the frame after a
    // teleport the controller may still report the ground it stood on before.
    this.arriving = this.state === "START_JUMP" ? 0 : Math.max(0, this.arriving - dt);

    this.computeVelocity(dt, gravity, this.newVelocity);
    if (this.state === "START_JUMP") {
      this.onJump.notifyObservers();
      if (previous === "SWIMMING") this.onSwimChanged.notifyObservers({ swimming: false, speed: 0 });
    }

    controller.setVelocity(this.newVelocity);
    // Afloat, the water carries the character's weight.
    controller.integrate(dt, this.support, this.state === "SWIMMING" ? this.zero : gravity);
    if (this.state === "ON_GROUND" && !this.stepUp(dt)) this.settleOntoGround();

    // Feet follow the capsule.
    this.root.position.copyFrom(controller.getPosition());
    this.root.position.y -= this.feetOffset;

    // Leg speed for the animation: how fast we actually ended up moving (so
    // running into a wall reads as standing), but never more than was asked
    // for (so being carried by a platform or shoved does not read as walking).
    const velocity = controller.getVelocity();
    this.groundSpeed = this.holding ? this.pace : Math.min(Math.hypot(velocity.x, velocity.z), this.desiredVelocity.length());
  }

  /**
   * Sweeps the capsule from `from` along (dx, dy, dz) and returns how far it
   * got before touching something. `this.settleCastOut` holds the hit, if any.
   */
  private sweep(from: Vector3, dx: number, dy: number, dz: number): number {
    const query = this.settleQuery;
    query.startPosition.copyFrom(from);
    query.endPosition.copyFrom(from).addInPlaceFromFloats(dx, dy, dz);
    (this.physics.getPhysicsPlugin() as HavokPlugin).shapeCast(query, this.settleCastIn, this.settleCastOut);
    const length = Math.hypot(dx, dy, dz);
    return this.settleCastOut.hasHit ? this.settleCastOut.hitFraction * length : length;
  }

  /** True when the surface the last sweep hit is flat enough to stand on. */
  private sweepHitIsWalkable(): boolean {
    return Math.abs(this.settleCastOut.hitNormal.y) >= this.controller.maxSlopeCosine;
  }

  /**
   * Walks up a ledge. When something too steep to walk on is about to block
   * the way, try the move from higher up: sweep the capsule up by
   * `stepHeight`, forward over the obstacle, then back down. Landing on
   * walkable ground higher than we started means it was a step, and the
   * capsule is placed on it. Doing this just *before* contact, rather than
   * after being stopped, keeps the pace steady up a flight of stairs.
   */
  private stepUp(dt: number): boolean {
    const s = this.settings;
    const want = this.desiredVelocity;
    const wantSpeed = Math.hypot(want.x, want.z);
    if (s.stepHeight <= 0 || wantSpeed < 0.2) return false;

    const controller = this.controller;
    const position = controller.getPosition();
    const dirX = want.x / wantSpeed;
    const dirZ = want.z / wantSpeed;
    const skin = s.skinWidth;
    const probe = this.stepProbe;

    // Ahead at foot level: will we run into something next frame? Slopes we
    // can simply walk up don't count; the solver handles those.
    const lookAhead = wantSpeed * dt + STEP_TRIGGER_MARGIN;
    const toObstacle = this.sweep(position, dirX * lookAhead, 0, dirZ * lookAhead);
    if (!this.settleCastOut.hasHit || this.sweepHitIsWalkable()) return false;

    // Up: is there headroom?
    let rise = this.sweep(position, 0, s.stepHeight, 0);
    if (this.settleCastOut.hasHit) rise -= skin;
    if (rise < STEP_MIN_RISE) return false;
    probe.copyFrom(position).addInPlaceFromFloats(0, rise, 0);

    // Forward at the raised height, to just past the obstacle: is it clear?
    const reach = toObstacle + STEP_FORWARD_PROBE;
    let ahead = this.sweep(probe, dirX * reach, 0, dirZ * reach);
    if (this.settleCastOut.hasHit) ahead -= skin;
    if (ahead < toObstacle + STEP_MIN_FORWARD) return false; // a wall
    probe.addInPlaceFromFloats(dirX * ahead, 0, dirZ * ahead);

    // Down: what is there to stand on?
    const drop = this.sweep(probe, 0, -(rise + skin), 0);
    if (!this.settleCastOut.hasHit || !this.sweepHitIsWalkable()) return false;
    probe.y += skin - drop;
    if (probe.y - position.y < STEP_MIN_RISE) return false; // same level: not a step

    // The capsule goes there now and waits; the visuals stay where they were
    // and walk over at the player's pace (see `present`).
    this.stepLag.addInPlace(position).subtractInPlace(probe);
    controller.setPosition(probe);
    controller.setVelocity(this.zero);
    this.steppedThisFrame = true;
    return true;
  }

  /**
   * Keeps the capsule on the ground. The controller counts any surface within
   * `groundStickDistance` as "touching", which is what keeps the character
   * grounded over crests and down slopes, but it never moves the capsule the
   * rest of the way down, so it would hover by up to that much. Sweeping the
   * capsule downward finds the real gap and removes it.
   *
   * The same sweep reaches `stepHeight` further, so walking off a stair or a
   * kerb steps down onto the next surface instead of launching into a fall.
   */
  private settleOntoGround(): void {
    const controller = this.controller;
    const s = this.settings;
    const skin = s.skinWidth;
    const slack = controller.keepDistance + controller.keepContactTolerance;
    const position = controller.getPosition();

    const gap = this.sweep(position, 0, -Math.max(slack, s.stepHeight + skin), 0);
    if (!this.settleCastOut.hasHit || gap <= skin) return;
    if (gap > slack) {
      // A real drop rather than slack: follow it only onto ground we can stand on.
      if (!this.sweepHitIsWalkable()) return;
      this.stepLag.y += gap - skin;
    }
    controller.setPosition(this.scratch.copyFrom(position).addInPlaceFromFloats(0, skin - gap, 0));
  }

  /**
   * True when the water here is deep enough to float in. Floating holds the
   * feet `floatDepth` below the surface; swimming starts when they are a
   * little deeper than that and stops when the ground has lifted them a
   * little higher.
   */
  private deepEnoughToSwim(): boolean {
    const s = this.settings;
    const surface = s.waterLevel?.(this.root.position) ?? null;
    if (surface === null) return false;
    this.waterSurface = surface;
    const depth = surface - (this.controller.getPosition().y - this.feetOffset);
    if (this.state === "SWIMMING") return depth > s.floatDepth - SWIM_EXIT_MARGIN;
    // Not while leaping out: the feet are still under for the first moments of a jump.
    return depth > s.floatDepth + SWIM_ENTER_MARGIN && this.controller.getVelocity().y < SWIM_LEAVE_SPEED;
  }

  private nextState(supported: boolean, dt: number, inWater: boolean): MoveState {
    this.jumpBuffer -= dt;
    const wantJump = this.jumpBuffer > 0;

    let next: MoveState;
    if (inWater && this.state !== "START_JUMP") {
      // A jump from the water is how you get out onto a bank or a ledge.
      next = wantJump && this.state === "SWIMMING" ? "START_JUMP" : "SWIMMING";
    } else if (this.state === "START_JUMP") {
      next = "IN_AIR";
    } else if (this.state === "ON_GROUND") {
      if (supported) {
        next = wantJump ? "START_JUMP" : "ON_GROUND";
      } else {
        // Walked off an edge: allow a late jump for a moment.
        next = "IN_AIR";
        this.coyote = this.settings.coyoteTime;
      }
    } else if (supported && !this.isLeavingSurface()) {
      next = "ON_GROUND";
    } else {
      this.coyote -= dt;
      next = wantJump && this.coyote > 0 ? "START_JUMP" : "IN_AIR";
    }

    if (next === "START_JUMP") {
      this.jumpBuffer = 0;
      this.coyote = 0;
    }
    return next;
  }

  /**
   * True while moving away from the surface underneath, as in the first frames
   * of a jump. The controller still reports that surface as support until the
   * gap exceeds its contact tolerance, and landing on it again would cancel the
   * jump (most visibly at high frame rates, where each frame rises very little).
   */
  private isLeavingSurface(): boolean {
    const relative = this.controller.getVelocity().subtractToRef(this.support.averageSurfaceVelocity, this.scratch);
    return Vector3.Dot(relative, this.support.averageSurfaceNormal) > LIFT_OFF_SPEED;
  }

  /** Works out the velocity to ask the capsule for this step, given the current state. */
  private computeVelocity(dt: number, gravity: Vector3, result: Vector3): void {
    const s = this.settings;
    const controller = this.controller;
    const current = controller.getVelocity();

    if (this.state === "START_JUMP") {
      // Launch speed that peaks exactly `jumpHeight` up: v = sqrt(2 g h).
      result.copyFrom(current);
      result.y = Math.sqrt(2 * gravity.length() * s.jumpHeight);
      return;
    }

    // Stick/WASD relative to where the camera looks, flattened onto the ground.
    const move = this.input.move;
    const swimming = this.state === "SWIMMING";
    const speed = (this.input.isDown("sprint") ? s.runSpeed : s.walkSpeed) * (swimming ? s.swimSpeed : 1);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const strafe = move.x * this.handedness;
    this.forward.set(sin, 0, cos);
    this.desiredVelocity.set((sin * move.y + cos * strafe) * speed, 0, (cos * move.y - sin * strafe) * speed);

    // Mid-step: the capsule is already on the ledge and the visuals are still
    // walking up to it. Wait for them, or stairs would be climbed at a sprint.
    this.pace = Math.max(this.desiredVelocity.length(), s.walkSpeed);
    const behind = Math.hypot(this.stepLag.x, this.stepLag.z);
    this.holding = this.state === "ON_GROUND" && behind > 1e-3;
    if (this.holding) {
      // If they arrive part-way through this step, the capsule covers the rest
      // of it, so every frame moves the same distance.
      const leftover = Math.max(0, 1 - behind / (this.pace * dt));
      this.desiredVelocity.scaleInPlace(leftover);
      this.resumePace = leftover > 0;
    }

    if (swimming) {
      this.holding = this.resumePace = false;
      // Water drags the character toward its swimming pace, and buoyancy
      // toward its floating height. Easing the vertical speed rather than
      // setting it lets a dive carry under for a moment before bobbing up.
      const drag = easing(WATER_DRAG, dt);
      result.x = current.x + (this.desiredVelocity.x - current.x) * drag;
      result.z = current.z + (this.desiredVelocity.z - current.z) * drag;
      const feet = controller.getPosition().y - this.feetOffset;
      const rise = clamp((this.waterSurface - s.floatDepth - feet) * BUOYANCY_RESPONSE, -BUOYANCY_MAX_SPEED, BUOYANCY_MAX_SPEED);
      result.y = current.y + (rise - current.y) * easing(BUOYANCY_RESPONSE * 1.5, dt);
      return;
    }

    if (this.state === "IN_AIR") {
      this.resumePace = false;
      // Steer a little, but leave the vertical speed to gravity.
      controller.acceleration = easing(s.airResponse, dt);
      controller.calculateMovementToRef(dt, this.forward, UP, current, this.zero, this.desiredVelocity, UP, result);
      result.y = current.y;
      gravity.scaleAndAddToRef(dt, result);
      this.fallSpeed = Math.max(0, -result.y);
      return;
    }

    // ON_GROUND: move along the surface, carried by it if it moves (platforms).
    const surfaceNormal = this.support.averageSurfaceNormal;
    const surfaceVelocity = this.support.averageSurfaceVelocity;
    controller.acceleration = easing(s.groundResponse, dt);
    controller.calculateMovementToRef(dt, this.forward, surfaceNormal, current, surfaceVelocity, this.desiredVelocity, UP, result);

    // Walking uphill gives a velocity that points up the slope. As in Babylon's
    // example, turn it back into a horizontal velocity of matching pace and
    // leave climbing the slope to the solver.
    result.subtractInPlace(surfaceVelocity);
    if (Vector3.Dot(result, UP) > 1e-3) {
      const length = result.length();
      result.scaleInPlace(1 / length);
      const horizontalLength = length / Vector3.Dot(surfaceNormal, UP);
      Vector3.CrossToRef(surfaceNormal, result, this.scratch);
      Vector3.CrossToRef(this.scratch, UP, result);
      result.scaleInPlace(horizontalLength);
    }
    result.addInPlace(surfaceVelocity);

    if (this.resumePace) {
      // Just finished a step: carry on at full pace rather than from a standstill.
      this.resumePace = false;
      result.x = this.desiredVelocity.x + surfaceVelocity.x;
      result.z = this.desiredVelocity.z + surfaceVelocity.z;
    }
  }

  // ---------------------------------------------------------------------
  // Phase 3: camera and visuals
  // ---------------------------------------------------------------------

  private present(): void {
    const dt = this.frameDt();
    // Let the visuals catch up with the capsule after a step. Stepping up
    // leaves them behind and below: they close that gap in a straight line at
    // walking pace, which reads as climbing a slope. Stepping down leaves them
    // only above, and they simply ease down.
    const lag = this.stepLag;
    const behind = Math.hypot(lag.x, lag.z);
    if (this.steppedThisFrame) {
      this.steppedThisFrame = false; // the capsule already moved this frame
    } else if (behind > 1e-3) {
      const remaining = Math.max(0, behind - this.pace * dt);
      lag.scaleInPlace(remaining / behind);
      if (remaining <= 1e-3) {
        lag.setAll(0);
        this.resumePace = true;
      }
    } else {
      lag.x = lag.z = 0;
      lag.y *= 1 - easing(STEP_SMOOTH_RESPONSE, dt);
      if (Math.abs(lag.y) < 1e-3) lag.y = 0;
    }

    this.updateFacing(dt);
    // The model hangs off `root`, which is turned to face `facing`; express the
    // world-space lag in that turned frame.
    const sin = Math.sin(this.facing);
    const cos = Math.cos(this.facing);
    // Afloat, the body rides the water: a slow bob and a slight roll. The
    // ripples are only painted on the surface, so this is what sells the swell.
    this.afloat += ((this.state === "SWIMMING" ? 1 : 0) - this.afloat) * easing(6, dt);
    if (this.afloat < 1e-3) this.afloat = 0;
    this.swimTime += dt;
    const bob = (Math.sin(this.swimTime * 3.7) * 0.7 + Math.sin(this.swimTime * 2.3 + 1.3) * 0.3) * SWIM_BOB * this.afloat;
    this.model.root.rotation.z = Math.sin(this.swimTime * 1.9) * 0.06 * this.afloat;
    this.model.root.position.set(lag.x * cos - lag.z * sin, this.modelRestY + lag.y + bob, lag.x * sin + lag.z * cos);
    this.updateCamera(dt);
    this.model.root.setEnabled(this.cameraDistance > HIDE_MODEL_DISTANCE);
    this.updateAnimation(dt);
  }

  private updateFacing(dt: number): void {
    const move = this.input.move;
    if (this.mode === "first") {
      // The body looks where the camera looks.
      this.facing = this.yaw;
    } else if (move.x !== 0 || move.y !== 0) {
      // Turn toward the direction of travel; standing still keeps the last heading.
      const heading = this.yaw + Math.atan2(move.x * this.handedness, move.y);
      this.facing = wrapAngle(this.facing + wrapAngle(heading - this.facing) * easing(this.settings.turnResponse, dt));
    }
    this.root.rotation.y = this.facing;
  }

  private updateCamera(dt: number): void {
    const s = this.settings;

    // Unit vector along the view direction.
    const cosPitch = Math.cos(this.pitch);
    this.forward.set(Math.sin(this.yaw) * cosPitch, -Math.sin(this.pitch), Math.cos(this.yaw) * cosPitch);

    // The orbit pivot slides down to the eye as the camera closes in, so
    // arriving in first person does not end with a vertical pop.
    const closeness = 1 - clamp(this.cameraDistance / s.thirdPersonMinDistance, 0, 1);
    const pivotHeight = s.thirdPersonPivotHeight + (s.eyeHeight - s.thirdPersonPivotHeight) * closeness;
    this.pivot.copyFrom(this.root.position).addInPlace(this.stepLag).addInPlaceFromFloats(0, pivotHeight, 0);

    const wanted = this.mode === "third" ? clamp(this.zoomDistance, s.thirdPersonMinDistance, s.thirdPersonMaxDistance) : 0;
    // Check the whole stretch the camera might occupy this frame, including
    // while it is still easing in from further out.
    const reach = Math.max(wanted, this.cameraDistance);
    const clear = reach > 0 ? this.clearDistance(reach) : 0;

    // Jump in front of an obstacle at once (never show the inside of a wall),
    // but ease everything else: zooming, switching modes, backing out again.
    if (clear < this.cameraDistance) this.cameraDistance = clear;
    this.cameraDistance += (Math.min(wanted, clear) - this.cameraDistance) * easing(CAMERA_DISTANCE_RESPONSE, dt);
    if (this.cameraDistance < 1e-3) this.cameraDistance = 0;

    this.forward.scaleToRef(-this.cameraDistance, this.camera.position).addInPlace(this.pivot);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  /**
   * How far behind the pivot the camera can sit, up to `reach`, before
   * something solid gets in the way. Uses `this.pivot` and `this.forward`.
   */
  private clearDistance(reach: number): number {
    const radius = this.settings.cameraCollisionRadius;
    this.forward.scaleToRef(-(reach + radius), this.rayEnd).addInPlace(this.pivot);
    this.physics.raycastToRef(this.pivot, this.rayEnd, this.rayHit, this.rayQuery);
    if (!this.rayHit.hasHit) return reach;

    // Stop `radius` short of the surface measured square to it, not along the
    // ray: a ray that skims a wall needs to back off further to keep the near
    // plane out of it. The floor of 0.1 only stops a divide by nearly zero.
    const squareness = Math.max(Math.abs(Vector3.Dot(this.forward, this.rayHit.hitNormalWorld)), 0.1);
    return clamp(this.rayHit.hitDistance - radius / squareness, 0, reach);
  }

  private startClip(name: string, weight: number): Clip {
    const group = this.model.animations.get(name);
    if (group) {
      group.weight = weight;
      group.start(true);
    }
    return { group, weight };
  }

  /**
   * The clip shown while off the ground: the model's own jump/fall clip if it
   * has one, otherwise a copy of the run cycle frozen mid-leap.
   */
  private startAirClip(): Clip {
    if (MODEL.clips.air) return this.startClip(MODEL.clips.air, 0);
    const run = this.model.animations.get(MODEL.clips.run);
    if (!run) return { group: undefined, weight: 0 };
    const pose = run.clone(`${run.name}:air`);
    pose.weight = 0;
    pose.start(true);
    pose.speedRatio = 0; // evaluated every frame, but never advances
    pose.goToFrame(run.from + (run.to - run.from) * MODEL.airPoseInRun);
    return { group: pose, weight: 0, held: true };
  }

  /** Cross-fades idle, walk, run and the airborne pose, and matches leg speed to ground speed. */
  private updateAnimation(dt: number): void {
    const s = this.settings;
    const speed = this.groundSpeed;
    // Clip speeds are in model units; convert to metres.
    const walkClipSpeed = MODEL.walkClipSpeed * this.modelScale;
    const runClipSpeed = MODEL.runClipSpeed * this.modelScale;

    // Idle gives way to walk over the range where the walk clip cannot play
    // slowly enough to match; walk gives way to run between the two speeds.
    const moving = clamp(speed / (walkClipSpeed * MIN_PLAYBACK_RATE), 0, 1);
    const running = clamp((speed - s.walkSpeed) / Math.max(s.runSpeed - s.walkSpeed, 1e-3), 0, 1);

    // The three targets always sum to 1, and easing them equally keeps it so,
    // which is what Babylon needs to blend clips without mixing in the bind pose.
    // Airborne (jumping or falling) takes over from all three once the feet
    // have been off the ground for a moment.
    const swimming = this.state === "SWIMMING";
    this.airTime = this.state === "ON_GROUND" || swimming || this.arriving > 0 ? 0 : this.airTime + dt;
    const airborne = this.air.group && this.airTime > AIR_POSE_DELAY ? 1 : 0;
    const afloat = swimming ? 1 : 0;
    const grounded = (1 - airborne) * (1 - afloat);

    // Swimming uses the model's swim clip if it has one. Otherwise the run
    // cycle, slowed down, makes a passable paddle: slowest when treading water.
    const stroke = clamp(speed / Math.max(s.runSpeed * s.swimSpeed, 1e-3), 0, 1);
    const paddle = MODEL.paddleRates[0] + (MODEL.paddleRates[1] - MODEL.paddleRates[0]) * stroke;
    const ownSwimClip = this.swim.group ? 1 : 0;

    const blend = easing(ANIMATION_BLEND_RESPONSE, dt);
    this.setClip(this.idle, (1 - moving) * grounded, blend, 1);
    this.setClip(this.walk, moving * (1 - running) * grounded, blend, speed / walkClipSpeed);
    if (swimming && !ownSwimClip) this.setClip(this.run, 1, blend, paddle);
    else this.setClip(this.run, moving * running * grounded, blend, speed / runClipSpeed);
    this.setClip(this.swim, afloat * ownSwimClip, blend, 0.6 + 0.6 * stroke);
    this.setClip(this.air, airborne, blend, 1);

    // Nose up on the way up, down on the way down; and a little up when afloat.
    const climb = this.state === "ON_GROUND" || swimming ? 0 : this.controller.getVelocity().y;
    const tilt = clamp(-climb * AIR_TILT_PER_SPEED, -AIR_TILT_MAX, AIR_TILT_MAX) * airborne + SWIM_TILT * afloat;
    this.airTilt += (tilt - this.airTilt) * blend;
    this.model.root.rotation.x = this.airTilt;
  }

  private setClip(clip: Clip, targetWeight: number, blend: number, playbackRate: number): void {
    clip.weight += (targetWeight - clip.weight) * blend;
    // Easing never quite arrives; land on zero so Babylon can stop evaluating the clip.
    if (targetWeight === 0 && clip.weight < 1e-3) clip.weight = 0;
    if (!clip.group) return;
    clip.group.weight = clip.weight;
    if (!clip.held) clip.group.speedRatio = clamp(playbackRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  }

  // ---------------------------------------------------------------------
  // Timing
  // ---------------------------------------------------------------------

  /** Seconds of game time this frame: capped after a hitch, and 0 while paused. */
  private frameDt(): number {
    return Math.min(this.clock.delta, MAX_DT);
  }

  /** Seconds covered by the physics step that just ran: the fixed sub-step if one is set, else the frame. */
  private physicsDt(): number {
    const subStep = this.physics.getSubTimeStep();
    return subStep > 0 ? Math.min(subStep / 1000, MAX_DT) : this.frameDt();
  }
}
