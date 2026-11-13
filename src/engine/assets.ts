import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AbstractMesh, AnimationGroup, AssetContainer, Scene, Skeleton } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const containers = new WeakMap<Scene, Map<string, Promise<AssetContainer>>>();

/**
 * Loads a glTF/GLB file into an off-scene container. Each URL is downloaded and
 * parsed once per scene; use `spawnModel` to put copies into the world.
 */
export function loadContainer(scene: Scene, url: string): Promise<AssetContainer> {
  let perScene = containers.get(scene);
  if (!perScene) containers.set(scene, (perScene = new Map()));
  let pending = perScene.get(url);
  if (!pending) perScene.set(url, (pending = LoadAssetContainerAsync(url, scene)));
  return pending;
}

export interface ModelInstance {
  /** Move/rotate/scale this. glTF content hangs underneath it. */
  root: TransformNode;
  meshes: AbstractMesh[];
  skeletons: Skeleton[];
  /** Animation clips by their name in the file. All start stopped. */
  animations: Map<string, AnimationGroup>;
  dispose(): void;
}

/**
 * Adds an independent copy of a model to the scene. Geometry and materials are
 * shared between copies; skeletons and animations are per copy.
 */
export async function spawnModel(scene: Scene, url: string, name = "model"): Promise<ModelInstance> {
  const container = await loadContainer(scene, url);
  const entries = container.instantiateModelsToScene((sourceName) => sourceName, false, { doNotInstantiate: true });

  const root = new TransformNode(name, scene);
  const meshes: AbstractMesh[] = [];
  for (const node of entries.rootNodes) {
    node.parent = root;
    meshes.push(...node.getChildMeshes(false));
  }

  const animations = new Map<string, AnimationGroup>();
  for (const group of entries.animationGroups) {
    group.stop();
    animations.set(group.name, group);
  }

  return {
    root,
    meshes,
    skeletons: entries.skeletons,
    animations,
    dispose() {
      entries.dispose();
      root.dispose();
    },
  };
}
