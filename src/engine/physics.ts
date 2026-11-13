import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { Scene } from "@babylonjs/core/scene";

type HavokInstance = Awaited<ReturnType<typeof HavokPhysics>>;

let havok: Promise<HavokInstance> | undefined;

// Physics advances by the real frame time. Cap that at 1/30 s: after a hitch
// (shader compile, tab switch) the game briefly runs slow instead of taking
// one huge step that flings stacked objects apart.
Scene.MaxDeltaTime = 1000 / 30;

/** Downloads and compiles the Havok WASM module once; later calls reuse it. */
export function loadHavok(): Promise<HavokInstance> {
  return (havok ??= HavokPhysics({ locateFile: () => havokWasmUrl }));
}

/**
 * Turns on Havok physics for a scene. After this, give meshes a body with
 * `new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 1 }, scene)`.
 */
export async function enablePhysics(scene: Scene, gravity = new Vector3(0, -9.81, 0)): Promise<HavokPlugin> {
  const plugin = new HavokPlugin(true, await loadHavok());
  scene.enablePhysics(gravity, plugin);
  return plugin;
}
