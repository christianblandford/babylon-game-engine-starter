import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Observable } from "@babylonjs/core/Misc/observable";
import { PhysicsEventType, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import { PhysicsShapeBox, PhysicsShapeSphere } from "@babylonjs/core/Physics/v2/physicsShape";
import type { IPhysicsEnginePluginV2, Mesh } from "@babylonjs/core";
import type { GameContext } from "./context";
import type { MapMarker, StreamedMap } from "./map";

/**
 * Trigger zones and things the player can use.
 *
 * A **zone** is a volume that reports what walks in and out of it: a doorway
 * that starts a cutscene, water that slows you, a checkpoint. Zones are
 * Havok trigger shapes, so the physics engine does the detecting, for the
 * player and for any other physics body (a crate pushed onto a pressure
 * plate). They block nothing, and rays and camera collision pass through.
 *
 * An **interactable** is a point the player can use by pressing the
 * `interact` action while close to it and looking roughly its way: a lever, a
 * door, a campfire. One at a time is "in focus"; the HUD shows its prompt.
 *
 * Both can be placed in Blender (see `followMap`) or made in code, and both
 * are known by a *name*. Game code reacts to names, so the level designer
 * decides where and the programmer decides what:
 *
 *   triggers.onEnter("ruins_gate", () => hud.toast("The old gate"));
 *   triggers.onInteract("campfire", (fire) => { ... });
 *
 * Several zones or interactables may share a name (every "water" pool).
 * Nothing fires while the game is paused.
 */

export interface ZoneOptions {
  name: string;
  /** Centre of the volume. */
  position: Vector3;
  /** Width, height and depth in metres; for a sphere the largest is its diameter. */
  size: Vector3;
  shape?: "box" | "sphere";
  /** Rotation about the vertical axis, in radians. */
  yaw?: number;
  /** The Blender Empty this came from, if it did. */
  marker?: MapMarker;
}

export interface Zone {
  readonly name: string;
  readonly position: Vector3;
  /** True while the player is inside. */
  readonly occupied: boolean;
  /** Every physics body inside right now, the player's included. */
  readonly bodies: ReadonlySet<PhysicsBody>;
  /** The Blender Empty this came from (its name and custom properties), if it did. */
  readonly marker?: MapMarker;
  remove(): void;
}

export interface ZoneEvent {
  zone: Zone;
  /** What crossed the boundary. `body.transformNode` is the object it belongs to. */
  body: PhysicsBody;
  isPlayer: boolean;
}

export interface ZoneHandlerOptions {
  /** Also fire for physics bodies other than the player (crates, balls, ...). */
  anyBody?: boolean;
}

export interface InteractableOptions {
  name: string;
  /** Where it is. Pass a mesh or node to have it follow something that moves. */
  at: Vector3 | TransformNode;
  /** What using it does, in a few words: shown to the player beside the key. */
  prompt?: string;
  /** How close (m) the player must be. */
  radius?: number;
  /** The Blender Empty this came from, if it did. */
  marker?: MapMarker;
}

export interface Interactable {
  readonly name: string;
  readonly position: Vector3;
  prompt: string;
  radius: number;
  /** Set false to make it unusable for now (a door that is already open). */
  enabled: boolean;
  /** The Blender Empty this came from (its name and custom properties), if it did. */
  readonly marker?: MapMarker;
  remove(): void;
}

/** Who counts as "the player": whose body sets off zones, and who must be near an interactable. */
export interface TriggerSubject {
  readonly body: PhysicsBody | null;
  /** Feet position. */
  readonly position: Vector3;
}

export interface Triggers {
  addZone(options: ZoneOptions): Zone;
  addInteractable(options: InteractableOptions): Interactable;
  /**
   * Creates the zones and interactables placed in Blender: Empties with a
   * custom property `trigger` (a zone, shaped like the Empty's cube or
   * sphere) or `interact` (with optional `prompt` and `radius`).
   */
  followMap(map: StreamedMap): void;
  /** Runs `handler` when the player (or with `anyBody`, anything) enters a zone of this name. */
  onEnter(name: string, handler: (event: ZoneEvent) => void, options?: ZoneHandlerOptions): void;
  onExit(name: string, handler: (event: ZoneEvent) => void, options?: ZoneHandlerOptions): void;
  /** Runs `handler` when the player uses an interactable of this name. */
  onInteract(name: string, handler: (target: Interactable) => void): void;
  /** The interactable the player could use right now, if any. */
  readonly focus: Interactable | null;
  /** True: nothing can be used for now and no prompt shows (a conversation has the interact key). Zones still report. */
  suspended: boolean;
  /** Fires when `focus` changes, or its prompt does. */
  readonly onFocusChanged: Observable<Interactable | null>;
  /** Every zone of this name. */
  zones(name: string): Zone[];
  /** Every interactable of this name. */
  interactables(name: string): Interactable[];
  /** Draws the zones and the reach of each interactable. */
  showDebug(visible: boolean): void;
  dispose(): void;
}

const DEFAULT_REACH = 2;
/** Where on the player reach is measured from, above the feet (m). */
const REACH_HEIGHT = 0.4;
/** An interactable must be within this angle of where the camera looks: cos of about 70 degrees. */
const FOCUS_CONE = 0.35;

interface ZoneHandler {
  handler: (event: ZoneEvent) => void;
  anyBody: boolean;
}

export function createTriggers(ctx: GameContext, subject: TriggerSubject): Triggers {
  const { scene, camera, input, clock } = ctx;
  const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin() as IPhysicsEnginePluginV2 | undefined;
  if (!plugin) throw new Error("createTriggers needs physics: call enablePhysics(scene) first.");

  interface ZoneState extends Zone {
    readonly node: TransformNode;
    readonly body: PhysicsBody;
    readonly inside: Set<PhysicsBody>;
    readonly options: ZoneOptions;
  }
  type InteractableState = Interactable;

  const zoneByBody = new Map<PhysicsBody, ZoneState>();
  const interactableList: InteractableState[] = [];
  const enterHandlers = new Map<string, ZoneHandler[]>();
  const exitHandlers = new Map<string, ZoneHandler[]>();
  const interactHandlers = new Map<string, ((target: Interactable) => void)[]>();
  const onFocusChanged = new Observable<Interactable | null>();
  let focus: InteractableState | null = null;
  let disposed = false;

  function listen<T>(map: Map<string, T[]>, name: string, entry: T): void {
    const list = map.get(name);
    if (list) list.push(entry);
    else map.set(name, [entry]);
  }

  // --- Zones ---------------------------------------------------------------

  const triggerObserver = plugin.onTriggerCollisionObservable.add((event) => {
    // Havok reports the pair in either order.
    let zone = zoneByBody.get(event.collidedAgainst);
    let other = event.collider;
    if (!zone) {
      zone = zoneByBody.get(event.collider);
      other = event.collidedAgainst;
    }
    if (!zone || zoneByBody.has(other)) return; // not ours, or two zones overlapping

    const entered = event.type === PhysicsEventType.TRIGGER_ENTERED;
    if (entered === zone.inside.has(other)) return; // nothing changed
    if (entered) zone.inside.add(other);
    else zone.inside.delete(other);

    const isPlayer = other === subject.body;
    const handlers = (entered ? enterHandlers : exitHandlers).get(zone.name);
    if (!handlers) return;
    const zoneEvent: ZoneEvent = { zone, body: other, isPlayer };
    // A copy, so a handler may register more handlers or remove the zone.
    for (const { handler, anyBody } of [...handlers]) {
      if (isPlayer || anyBody) handler(zoneEvent);
    }
  });

  function addZone(options: ZoneOptions): Zone {
    const node = new TransformNode(`zone:${options.name}`, scene);
    node.position.copyFrom(options.position);
    node.rotationQuaternion = Quaternion.RotationAxis(Vector3.UpReadOnly, options.yaw ?? 0);

    const size = options.size;
    const shape =
      options.shape === "sphere"
        ? new PhysicsShapeSphere(Vector3.Zero(), Math.max(size.x, size.y, size.z) / 2, scene)
        : new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), size.clone(), scene);
    shape.isTrigger = true;
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
    body.shape = shape;

    const inside = new Set<PhysicsBody>();
    const zone: ZoneState = {
      name: options.name,
      marker: options.marker,
      position: node.position,
      node,
      body,
      inside,
      options,
      bodies: inside,
      get occupied() {
        return subject.body !== null && inside.has(subject.body);
      },
      remove() {
        if (!zoneByBody.delete(body)) return;
        body.dispose();
        shape.dispose();
        node.dispose();
        refreshDebug();
      },
    };
    zoneByBody.set(body, zone);
    refreshDebug();
    return zone;
  }

  // --- Interactables ---------------------------------------------------------

  function addInteractable(options: InteractableOptions): Interactable {
    const at = options.at;
    let prompt = options.prompt ?? "Use";
    const target: InteractableState = {
      name: options.name,
      marker: options.marker,
      radius: options.radius ?? DEFAULT_REACH,
      enabled: true,
      get position() {
        return at instanceof Vector3 ? at : at.getAbsolutePosition();
      },
      get prompt() {
        return prompt;
      },
      set prompt(text: string) {
        if (text === prompt) return;
        prompt = text;
        if (focus === target) onFocusChanged.notifyObservers(target);
      },
      remove() {
        const index = interactableList.indexOf(target);
        if (index < 0) return;
        interactableList.splice(index, 1);
        if (focus === target) setFocus(null);
        refreshDebug();
      },
    };
    interactableList.push(target);
    refreshDebug();
    return target;
  }

  function setFocus(next: InteractableState | null): void {
    if (next === focus) return;
    focus = next;
    onFocusChanged.notifyObservers(next);
  }

  const reachFrom = new Vector3();
  const toTarget = new Vector3();
  const forward = new Vector3();

  /** The nearest usable interactable in reach that the camera isn't facing away from. */
  function findFocus(): InteractableState | null {
    reachFrom.copyFrom(subject.position).addInPlaceFromFloats(0, REACH_HEIGHT, 0);
    camera.getDirectionToRef(Vector3.Forward(), forward);
    let best: InteractableState | null = null;
    let bestDistance = Infinity;
    for (const target of interactableList) {
      if (!target.enabled) continue;
      const position = target.position;
      const distance = Vector3.Distance(reachFrom, position);
      if (distance > target.radius || distance >= bestDistance) continue;
      // Judged from the camera, so it works the same in first and third person.
      position.subtractToRef(camera.globalPosition, toTarget);
      if (Vector3.Dot(toTarget.normalize(), forward) < FOCUS_CONE) continue;
      best = target;
      bestDistance = distance;
    }
    return best;
  }

  let suspended = false;
  const frameObserver = scene.onBeforeRenderObservable.add(() => {
    if (clock.paused) return;
    if (suspended) {
      setFocus(null);
      return;
    }
    setFocus(findFocus());
    if (focus && input.wasPressed("interact")) {
      const used = focus;
      for (const handler of [...(interactHandlers.get(used.name) ?? [])]) handler(used);
    }
  });

  // --- Debug view ------------------------------------------------------------

  let debugVisible = false;
  let debugMeshes: Mesh[] = [];
  let zoneMaterial: StandardMaterial | null = null;
  let reachMaterial: StandardMaterial | null = null;

  function debugMaterial(name: string, color: Color3): StandardMaterial {
    const material = new StandardMaterial(name, scene);
    material.emissiveColor = color;
    material.disableLighting = true;
    material.alpha = 0.22;
    material.backFaceCulling = false; // visible from inside too
    return material;
  }

  function refreshDebug(): void {
    for (const mesh of debugMeshes) mesh.dispose();
    debugMeshes = [];
    if (!debugVisible || disposed) return;
    zoneMaterial ??= debugMaterial("zone-debug", new Color3(1, 0.45, 0.05));
    reachMaterial ??= debugMaterial("reach-debug", new Color3(0.1, 0.8, 0.3));

    for (const zone of zoneByBody.values()) {
      const { size, shape } = zone.options;
      const mesh =
        shape === "sphere"
          ? CreateSphere(`debug:${zone.name}`, { diameter: Math.max(size.x, size.y, size.z), segments: 16 }, scene)
          : CreateBox(`debug:${zone.name}`, { width: size.x, height: size.y, depth: size.z }, scene);
      mesh.parent = zone.node;
      mesh.material = zoneMaterial;
      debugMeshes.push(mesh);
    }
    for (const target of interactableList) {
      const mesh = CreateSphere(`debug:${target.name}`, { diameter: target.radius * 2, segments: 16 }, scene);
      mesh.position.copyFrom(target.position);
      mesh.material = reachMaterial;
      debugMeshes.push(mesh);
    }
    for (const mesh of debugMeshes) mesh.isPickable = false;
  }

  // --- Lifetime ----------------------------------------------------------------

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    plugin!.onTriggerCollisionObservable.remove(triggerObserver);
    scene.onBeforeRenderObservable.remove(frameObserver);
    for (const zone of [...zoneByBody.values()]) zone.remove();
    interactableList.length = 0;
    refreshDebug();
    zoneMaterial?.dispose();
    reachMaterial?.dispose();
    onFocusChanged.clear();
  }
  // Before the scene tears physics down, which the zone bodies need to be freed properly.
  scene.onDisposeObservable.addOnce(dispose);

  return {
    addZone,
    addInteractable,
    followMap(map) {
      for (const marker of map.manifest.markers) {
        const position = Vector3.FromArray(marker.position);
        if (typeof marker.props.trigger === "string") {
          const size = marker.size ? Vector3.FromArray(marker.size) : new Vector3(2, 2, 2);
          addZone({ name: marker.props.trigger, position, size, shape: marker.shape, yaw: marker.yaw, marker });
        }
        if (typeof marker.props.interact === "string") {
          addInteractable({
            name: marker.props.interact,
            at: position,
            prompt: typeof marker.props.prompt === "string" ? marker.props.prompt : undefined,
            radius: typeof marker.props.radius === "number" ? marker.props.radius : undefined,
            marker,
          });
        }
      }
    },
    onEnter(name, handler, options) {
      listen(enterHandlers, name, { handler, anyBody: options?.anyBody ?? false });
    },
    onExit(name, handler, options) {
      listen(exitHandlers, name, { handler, anyBody: options?.anyBody ?? false });
    },
    onInteract(name, handler) {
      listen(interactHandlers, name, handler);
    },
    get focus() {
      return focus;
    },
    get suspended() {
      return suspended;
    },
    set suspended(on: boolean) {
      suspended = on;
    },
    onFocusChanged,
    zones: (name) => [...zoneByBody.values()].filter((zone) => zone.name === name),
    interactables: (name) => interactableList.filter((target) => target.name === name),
    showDebug(visible) {
      debugVisible = visible;
      refreshDebug();
    },
    dispose,
  };
}
