import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { PhysicsMotionType, PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import type { GameContext } from "../engine/context";
import type { Effects } from "../engine/effects";
import type { MapMarker, StreamedMap } from "../engine/map";
import type { Interactable, Triggers } from "../engine/triggers";
import type { Hud } from "./hud";

export interface InteractionSystems {
  triggers: Triggers;
  effects: Effects;
  hud: Hud;
  map: StreamedMap | null;
  /** Tells navigation that a mesh made here is (or is no longer) in the way. */
  blockNavigation(mesh: Mesh, blocked: boolean): void;
}

/**
 * What happens when the player walks into a zone or uses something. The zones
 * and interactables themselves are placed in Blender (or below, in code);
 * here they are only referred to by name, so a name no level uses simply
 * never fires. Replace all of this with your game's own.
 */
export function setUpInteractions(ctx: GameContext, systems: InteractionSystems): void {
  everywhere(ctx, systems);
  island(ctx, systems);
  town(ctx, systems);
}

/** Reactions that suit any level. */
function everywhere(_ctx: GameContext, { triggers, effects }: InteractionSystems): void {
  // A fire that can be put out and relit. The same Empty carries the effect
  // (`fx`) and the interaction (`interact`), so using it switches that effect.
  // Any number of fires can share the name; each keeps its own state.
  const out = new Set<Interactable>();
  triggers.onInteract("campfire", (fire) => {
    if (!fire.marker) return;
    const relight = out.delete(fire);
    if (!relight) out.add(fire);
    effects.setPlaced(fire.marker.name, relight);
    fire.prompt = relight ? "Put out the fire" : "Light the fire";
    if (relight) effects.burst("sparks", fire.position);
  });
}

/** The test island (tools/blender/make_test_map.py) and the demo props (level.ts). */
function island({ scene, audio }: GameContext, { triggers, hud }: InteractionSystems): void {
  // Placed in Blender: a zone under the stone arch.
  triggers.onEnter("ruins_gate", () => {
    hud.toast("The old gate");
    audio.play("land", { volume: 0.5, playbackRate: 0.6 });
  });

  // Made in code: the glowing ball on the platform can be switched off.
  const beacon = scene.getMeshByName("beacon");
  const glass = beacon?.material;
  if (beacon && glass instanceof PBRMaterial) {
    const bright = glass.emissiveIntensity;
    let lit = true;
    triggers.addInteractable({ name: "beacon", at: beacon, prompt: "Switch off the beacon", radius: 2.5 });
    triggers.onInteract("beacon", (target) => {
      lit = !lit;
      glass.emissiveIntensity = lit ? bright : 0.15;
      target.prompt = lit ? "Switch off the beacon" : "Switch on the beacon";
    });
  }

  // Made in code: a zone over the row of balls that reacts to anything, not
  // just the player. Push a ball out of it and it says so.
  if (scene.getMeshByName("rubber")) {
    triggers.addZone({ name: "ball_rack", position: new Vector3(0, 1, 5), size: new Vector3(6, 2, 2.5) });
    triggers.onExit(
      "ball_rack",
      ({ body, isPlayer }) => {
        if (isPlayer) return;
        // A body also "leaves" when the map suspends it because its ground has
        // unloaded (the player walked far away). Only a ball that really is
        // outside counts.
        const at = body.transformNode.getAbsolutePosition();
        if (Math.abs(at.x) < 3 && Math.abs(at.z - 5) < 1.25) return;
        hud.toast(`${body.transformNode.name} left the rack`);
      },
      { anyBody: true },
    );
  }
}

/** The test town (tools/blender/make_test_town.py). */
function town(ctx: GameContext, systems: InteractionSystems): void {
  const { audio } = ctx;
  const { triggers, effects, hud, map } = systems;

  // Zones: say where you are. The moat is four zones sharing one name.
  triggers.onEnter("town_gate", () => hud.toast("The town gate"));
  triggers.onEnter("market_square", () => hud.toast("Market square"));
  triggers.onEnter("wall_walk", () => hud.toast("The wall walk"));
  triggers.onEnter("hall_terrace", () => hud.toast("The hall"));
  triggers.onEnter("moat", () => hud.toast("The moat"));

  // Things to use.
  triggers.onInteract("well", (well) => {
    hud.toast("The bucket comes up full.");
    audio.play("land", { volume: 0.4, playbackRate: 1.6 });
    effects.burst("dust", well.position);
  });
  triggers.onInteract("hall_door", () => {
    audio.play("land", { volume: 0.7, playbackRate: 1.3 });
    setTimeout(() => audio.play("land", { volume: 0.7, playbackRate: 1.3 }), 180);
    hud.toast("Nobody answers.");
  });

  // The gate: Blender marks where it goes and how big it is; the moving part
  // is built here.
  const gateway = map?.manifest.markers.find((marker) => marker.props.kind === "portcullis");
  if (gateway) portcullis(ctx, systems, gateway);
}

/** How fast the gate moves (m/s). */
const GATE_SPEED = 1.8;

/**
 * A portcullis filling the opening a marker describes, worked by the
 * `gate_lever` interactable. It is an animated physics body: the game moves
 * it and it pushes whatever it meets. While it is down, navigation is told,
 * so characters stop trying to walk through the gateway.
 */
function portcullis(ctx: GameContext, { triggers, hud, blockNavigation }: InteractionSystems, marker: MapMarker): void {
  const { scene, lighting, clock, audio } = ctx;
  const [width, height] = marker.size ?? [6, 4.4, 0.3];

  const metal = new PBRMaterial("portcullis", scene);
  metal.albedoColor = new Color3(0.06, 0.06, 0.065);
  metal.metallic = 0.9;
  metal.roughness = 0.5;

  const bars: Mesh[] = [];
  for (let x = -width / 2 + 0.25; x < width / 2; x += 0.5) {
    const bar = CreateBox("bar", { width: 0.12, height, depth: 0.12 }, scene);
    bar.position.x = x;
    bars.push(bar);
  }
  for (let y = -height / 2 + 0.3; y < height / 2; y += 0.8) {
    const rail = CreateBox("rail", { width, height: 0.1, depth: 0.2 }, scene);
    rail.position.y = y;
    bars.push(rail);
  }
  const gate = Mesh.MergeMeshes(bars, true)!;
  gate.name = "portcullis";
  gate.material = metal;
  gate.rotation.y = marker.yaw;
  gate.receiveShadows = true;
  lighting.addShadowCaster(gate);

  // The marker sits on the ground in the middle of the opening.
  const closedY = marker.position[1] + height / 2;
  const lift = height - 0.5; // how far it rises: clear of a walker's head, hidden in the stonework above
  let raised = lift;
  let target = lift;
  gate.position.set(marker.position[0], closedY + raised, marker.position[2]);

  const { body } = new PhysicsAggregate(gate, PhysicsShapeType.BOX, { mass: 0, extents: new Vector3(width, height, 0.3) }, scene);
  body.setMotionType(PhysicsMotionType.ANIMATED);
  body.disablePreStep = false; // follow the mesh as it is moved

  // A lever to look at, where the interactable is.
  for (const lever of triggers.interactables("gate_lever")) {
    const post = CreateCylinder("lever-post", { diameter: 0.14, height: 1 }, scene);
    post.position.copyFrom(lever.position).addInPlaceFromFloats(0, -0.5, 0);
    post.material = metal;
    const handle = CreateBox("lever-handle", { width: 0.07, height: 0.55, depth: 0.07 }, scene);
    handle.parent = post;
    handle.setPivotPoint(new Vector3(0, -0.25, 0));
    handle.position.y = 0.7;
    handle.rotation.x = -0.6;
    handle.material = metal;
    lighting.addShadowCaster(post, true);
    scene.onBeforeRenderObservable.add(() => {
      const wanted = target === 0 ? 0.6 : -0.6;
      handle.rotation.x += Math.sign(wanted - handle.rotation.x) * Math.min(Math.abs(wanted - handle.rotation.x), clock.delta * 4);
    });
  }

  triggers.onInteract("gate_lever", (lever) => {
    const lowering = target !== 0;
    // Not onto anyone's head. (The raised gate itself hangs into the zone, so it doesn't count.)
    const inTheWay = triggers.zones("town_gate").some((zone) => [...zone.bodies].some((other) => other !== body));
    if (lowering && inTheWay) {
      hud.toast("Something is in the gateway.");
      return;
    }
    target = lowering ? 0 : lift;
    lever.prompt = lowering ? "Raise the gate" : "Lower the gate";
    if (!lowering) blockNavigation(gate, false); // passable again as soon as it starts to rise
    audio.play("land", { volume: 0.5, playbackRate: 2 });
  });

  scene.onBeforeRenderObservable.add(() => {
    if (raised === target) return;
    const step = GATE_SPEED * clock.delta;
    raised = raised < target ? Math.min(target, raised + step) : Math.max(target, raised - step);
    gate.position.y = closedY + raised;
    if (raised !== target) return;
    audio.play("land", { volume: 0.9, playbackRate: 0.45 });
    if (target === 0) blockNavigation(gate, true);
  });
}
