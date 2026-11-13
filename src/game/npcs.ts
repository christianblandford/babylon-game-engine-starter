import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult";
import type { AnimationGroup, PhysicsEngineV2 } from "@babylonjs/core";
import { ASSETS } from "../config";
import { spawnModel, type ModelInstance } from "../engine/assets";
import type { GameContext } from "../engine/context";
import type { NavAgent, Navigation } from "../engine/navigation";

/**
 * A few foxes that wander about and now and then trot over to the player: a
 * small example of putting characters on the navmesh (`engine/navigation.ts`).
 *
 * Each one is a nav agent, which decides where the feet go, plus a model that
 * follows it. Everything here advances by game time, so pausing freezes them.
 */

export interface NpcOptions {
  /** They start in a small ring around this point. */
  around: Vector3;
  count?: number;
  /** Someone to visit from time to time: anything with a position, usually the player. */
  player?: { readonly position: Vector3 };
}

/** Everything specific to the model: the same fox as the player, a little smaller. */
const MODEL = {
  url: ASSETS.fox,
  /** Metres from paws to ear tips. */
  height: 0.55,
  clips: { idle: "Survey", walk: "Walk", run: "Run" },
  /** Ground speed each clip was animated for, in the file's own units per second (see player.ts). */
  walkClipSpeed: 120,
  runClipSpeed: 220,
};

/** Metres per second. */
const WANDER_SPEED = 0.9;
const TROT_SPEED = 2.4;
/** How far from where it stands a fox picks its next spot to wander to. */
const WANDER_RADIUS = 12;
/** Each time a fox picks something to do, this is the chance it goes to see the player, if within range (m). */
const VISIT_CHANCE = 0.3;
const VISIT_RANGE = 40;
/** A visiting fox stops this far (m) from the player. */
const VISIT_DISTANCE = 1.5;
/** The room (m) the foxes leave around the player when passing: the player's capsule radius. */
const PLAYER_RADIUS = 0.3;
/** Seconds between decisions: at least this, plus up to as much again. */
const DECISION_TIME = 4;
/** How fast the body turns to face where it is going, and animation weights follow speed, per second. */
const TURN_RESPONSE = 8;
const BLEND_RESPONSE = 10;
/** Limits on clip playback rate when matching the legs to ground speed. */
const MIN_PLAYBACK_RATE = 0.5;
const MAX_PLAYBACK_RATE = 2.5;
/** How far above and below the navmesh (m) to look for the real ground. */
const GROUND_PROBE = 0.4;

interface Clip {
  group: AnimationGroup | undefined;
  weight: number;
}

interface Npc {
  agent: NavAgent;
  /** At the feet; `rotation.y` is the way it faces. The model hangs underneath. */
  root: TransformNode;
  model: ModelInstance;
  scale: number;
  idle: Clip;
  walk: Clip;
  run: Clip;
  /** Seconds until it next decides what to do. */
  wait: number;
  visiting: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Fraction of a gap to close this frame so easing looks the same at any frame rate. */
function easing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Wraps an angle to -PI..PI. */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians));
}

/**
 * Spawns the foxes. They need no looking after: each stands still until there
 * is navmesh under it (`navigation.ready` can still be false when this is
 * called), and carries on by itself when the navmesh is rebuilt.
 */
export async function createNpcs(ctx: GameContext, navigation: Navigation, options: NpcOptions): Promise<{ dispose(): void }> {
  const { scene, clock, lighting } = ctx;
  const { around, count = 3, player } = options;

  const npcs = await Promise.all(
    Array.from({ length: count }, async (_, i): Promise<Npc> => {
      const model = await spawnModel(scene, MODEL.url, `npc-fox-${i}`);
      const root = new TransformNode(`npc-${i}`, scene);

      // Scale by the model's measured height and stand its lowest point on the ground.
      const bounds = model.root.getHierarchyBoundingVectors();
      const scale = MODEL.height / (bounds.max.y - bounds.min.y);
      model.root.parent = root;
      model.root.scaling.setAll(scale);
      model.root.position.y = -bounds.min.y * scale;
      for (const mesh of model.meshes) lighting.addShadowCaster(mesh);

      // All three clips loop permanently; only their weights change.
      const clip = (name: string, weight: number): Clip => {
        const group = model.animations.get(name);
        if (group) {
          group.weight = weight;
          group.start(true);
        }
        return { group, weight };
      };

      const angle = (i / count) * Math.PI * 2;
      const start = around.add(new Vector3(Math.cos(angle) * 2.5, 0, Math.sin(angle) * 2.5));
      const agent = navigation.addAgent(start, { speed: WANDER_SPEED });
      root.position.copyFrom(agent.position);
      root.rotation.y = angle;
      return {
        agent,
        root,
        model,
        scale,
        idle: clip(MODEL.clips.idle, 1),
        walk: clip(MODEL.clips.walk, 0),
        run: clip(MODEL.clips.run, 0),
        wait: 1 + Math.random() * DECISION_TIME, // not all at once
        visiting: false,
      };
    }),
  );

  // The player is not moved by the crowd, but the foxes should still walk
  // around them rather than through: an agent that is simply put where the
  // player is, every frame, is something for the others to avoid.
  const playerMarker = player ? navigation.addAgent(player.position, { radius: PLAYER_RADIUS }) : null;

  /** Picks something to do every few seconds: wander somewhere nearby, or go and see the player. */
  function think(npc: Npc, dt: number): void {
    const { agent } = npc;
    if (npc.visiting && player && Vector3.Distance(agent.position, player.position) < VISIT_DISTANCE) {
      agent.stop();
      npc.visiting = false;
    }
    npc.wait -= dt;
    if (npc.wait > 0) return;

    const visit = !!player && Math.random() < VISIT_CHANCE && Vector3.Distance(agent.position, player.position) < VISIT_RANGE;
    const target = visit ? player.position : navigation.randomPointAround(agent.position, WANDER_RADIUS);
    agent.speed = visit ? TROT_SPEED : WANDER_SPEED;
    // No target, or `goTo` false, means there is no navmesh there (or not yet): try again shortly.
    const going = target !== null && agent.goTo(target);
    npc.visiting = visit && going;
    npc.wait = going ? DECISION_TIME * (1 + Math.random()) : 1;
  }

  // The navmesh is built from coarse voxels and floats a few centimetres above
  // the surface it was made from, more on slopes. The agent says where to
  // stand; a short ray down through that spot finds the ground itself.
  const physics = scene.getPhysicsEngine() as PhysicsEngineV2 | null;
  const rayStart = new Vector3();
  const rayEnd = new Vector3();
  const rayHit = new PhysicsRaycastResult();

  /** Puts the model where its agent is, feet on the ground, turning to face the way it is going. */
  function place(npc: Npc, speed: number, dt: number): void {
    const { agent, root } = npc;
    root.position.copyFrom(agent.position);
    if (physics) {
      rayStart.copyFrom(agent.position).y += GROUND_PROBE;
      rayEnd.copyFrom(agent.position).y -= GROUND_PROBE;
      physics.raycastToRef(rayStart, rayEnd, rayHit);
      if (rayHit.hasHit) root.position.y = rayHit.hitPointWorld.y;
    }
    if (speed > 0.1) {
      const heading = Math.atan2(agent.velocity.x, agent.velocity.z);
      root.rotation.y += wrapAngle(heading - root.rotation.y) * easing(TURN_RESPONSE, dt);
    }
  }

  /** Cross-fades idle, walk and run by actual speed, and matches leg speed to ground speed (as player.ts does). */
  function animate(npc: Npc, speed: number, dt: number): void {
    // Clip speeds are in model units; convert to metres.
    const walkClipSpeed = MODEL.walkClipSpeed * npc.scale;
    const runClipSpeed = MODEL.runClipSpeed * npc.scale;
    const moving = clamp(speed / (walkClipSpeed * MIN_PLAYBACK_RATE), 0, 1);
    const running = clamp((speed - WANDER_SPEED) / (TROT_SPEED - WANDER_SPEED), 0, 1);

    // The three targets always sum to 1, which Babylon needs to blend clips cleanly.
    const blend = easing(BLEND_RESPONSE, dt);
    const set = (clip: Clip, target: number, playbackRate: number): void => {
      clip.weight += (target - clip.weight) * blend;
      if (!clip.group) return;
      clip.group.weight = clip.weight;
      clip.group.speedRatio = clamp(playbackRate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
    };
    set(npc.idle, 1 - moving, 1);
    set(npc.walk, moving * (1 - running), speed / walkClipSpeed);
    set(npc.run, moving * running, speed / runClipSpeed);
  }

  // Runs after navigation's own update (it was created first), so agents have already moved this frame.
  const observer = scene.onBeforeRenderObservable.add(() => {
    const dt = clock.delta;
    if (dt <= 0) return; // paused
    if (player) playerMarker?.teleport(player.position);
    for (const npc of npcs) {
      const speed = Math.hypot(npc.agent.velocity.x, npc.agent.velocity.z);
      think(npc, dt);
      place(npc, speed, dt);
      animate(npc, speed, dt);
    }
  });

  return {
    dispose() {
      scene.onBeforeRenderObservable.remove(observer);
      playerMarker?.remove();
      for (const npc of npcs) {
        npc.agent.remove();
        npc.model.dispose();
        npc.root.dispose();
      }
      npcs.length = 0;
    },
  };
}
