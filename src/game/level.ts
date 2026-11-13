import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import type { Mesh, Scene } from "@babylonjs/core";
import type { GameContext } from "../engine/context";
import type { StreamedMap } from "../engine/map";

interface Surface {
  color: Color3;
  /** 0 = mirror-smooth, 1 = chalky. */
  roughness?: number;
  /** 0 = plastic/stone/wood, 1 = bare metal. */
  metallic?: number;
  /** Glow colour; values above 1 (via `glow`) feed the bloom effect. */
  emissive?: Color3;
  glow?: number;
}

/** Physically based material: the same three knobs describe almost any surface. */
function surface(scene: Scene, name: string, s: Surface): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = s.color;
  material.roughness = s.roughness ?? 0.7;
  material.metallic = s.metallic ?? 0;
  if (s.emissive) {
    material.emissiveColor = s.emissive;
    material.emissiveIntensity = s.glow ?? 1;
  }
  return material;
}

/** A 1 m "prototype grid" texture, drawn at runtime so the scaffold ships no image files. */
function gridTexture(scene: Scene): DynamicTexture {
  const size = 512;
  const texture = new DynamicTexture("grid", size, scene, true);
  const g = texture.getContext();
  g.fillStyle = "#8d9296";
  g.fillRect(0, 0, size, size);
  g.fillStyle = "#858a8e";
  g.fillRect(0, 0, size / 2, size / 2);
  g.fillRect(size / 2, size / 2, size / 2, size / 2);
  g.strokeStyle = "#6f7478";
  g.lineWidth = 4;
  g.strokeRect(0, 0, size, size);
  g.strokeRect(0, 0, size / 2, size / 2);
  g.strokeRect(size / 2, size / 2, size / 2, size / 2);
  texture.update();
  texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  return texture;
}

/**
 * Demo props built in code: static geometry to climb and dynamic objects to
 * shove around, placed on the flat area at the map's origin. Replace with your
 * own gameplay objects.
 */
export function buildLevel(ctx: GameContext, map: StreamedMap | null): { statics: Mesh[] } {
  const { scene, lighting } = ctx;
  /** Immovable geometry, for anything that needs to know where characters can walk. */
  const statics: Mesh[] = [];

  /** Solid, immovable, shadowed. */
  const solid = (mesh: Mesh, shape = PhysicsShapeType.BOX): Mesh => {
    mesh.receiveShadows = true;
    lighting.addShadowCaster(mesh);
    new PhysicsAggregate(mesh, shape, { mass: 0, friction: 0.8 }, scene);
    statics.push(mesh);
    return mesh;
  };
  /** Movable prop. */
  const prop = (mesh: Mesh, shape: PhysicsShapeType, mass: number, restitution = 0.1): Mesh => {
    mesh.receiveShadows = true;
    lighting.addShadowCaster(mesh);
    const { body } = new PhysicsAggregate(mesh, shape, { mass, friction: 0.6, restitution }, scene);
    map?.anchor(body); // don't fall through the world while the ground here is unloaded
    return mesh;
  };

  // --- Ground ----------------------------------------------------------------
  // Only when no map is loaded; a streamed map brings its own terrain.
  if (!map) {
    const groundSize = 400;
    const ground = MeshBuilder.CreateGround("ground", { width: groundSize, height: groundSize }, scene);
    const groundMaterial = surface(scene, "ground", { color: Color3.White(), roughness: 0.92 });
    const grid = gridTexture(scene);
    grid.uScale = grid.vScale = groundSize / 2; // one texture repeat = 2 m
    groundMaterial.albedoTexture = grid;
    ground.material = groundMaterial;
    ground.receiveShadows = true;
    new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0, friction: 0.9 }, scene);
    statics.push(ground);
  }

  // --- Static geometry -------------------------------------------------------
  const concrete = surface(scene, "concrete", { color: new Color3(0.62, 0.6, 0.57), roughness: 0.85 });
  const accent = surface(scene, "accent", { color: new Color3(0.85, 0.33, 0.12), roughness: 0.55 });

  const platform = MeshBuilder.CreateBox("platform", { width: 6, height: 1.5, depth: 6 }, scene);
  platform.position.set(-8, 0.75, 6);
  platform.material = concrete;
  solid(platform);

  const ramp = MeshBuilder.CreateBox("ramp", { width: 3, height: 0.3, depth: 7 }, scene);
  ramp.position.set(-8, 0.62, -0.25);
  ramp.rotation.x = -Math.atan2(1.5, 6.6);
  ramp.material = accent;
  solid(ramp);

  // A solid staircase up onto the platform. The risers are 0.15 m: low enough
  // for the player to walk up (see `stepHeight` in player.ts). Make them taller
  // than that and they become something to jump.
  const risers = 10;
  for (let i = 0; i < risers; i++) {
    const rise = (1.5 / risers) * (i + 1);
    const step = MeshBuilder.CreateBox(`step${i}`, { width: 0.4, height: rise, depth: 2 }, scene);
    step.position.set(-1.2 - i * 0.4, rise / 2, 7.5);
    step.material = concrete;
    solid(step);
  }

  const wall = MeshBuilder.CreateBox("wall", { width: 10, height: 3, depth: 0.5 }, scene);
  wall.position.set(6, 1.5, 10);
  wall.material = concrete;
  solid(wall);

  // --- Dynamic props ---------------------------------------------------------
  // A pyramid of crates. Instances share one mesh + material, so the whole
  // stack is a single draw call however many there are.
  const crate = MeshBuilder.CreateBox("crate", { size: 0.7 }, scene);
  crate.material = surface(scene, "crate", { color: new Color3(0.72, 0.52, 0.3), roughness: 0.75 });
  crate.receiveShadows = true; // instances inherit this from their source mesh
  crate.isVisible = false;
  const rows = 4;
  for (let row = 0; row < rows; row++) {
    for (let i = 0; i < rows - row; i++) {
      const instance = crate.createInstance(`crate_${row}_${i}`);
      instance.position.set(4 + (i + row / 2) * 0.75, 0.36 + row * 0.71, 3);
      lighting.addShadowCaster(instance);
      // Asleep until something touches them, so the stack is rock-steady at rest.
      const { body } = new PhysicsAggregate(
        instance,
        PhysicsShapeType.BOX,
        { mass: 6, friction: 0.6, restitution: 0.05, startAsleep: true },
        scene,
      );
      map?.anchor(body);
    }
  }

  // Three balls that show off what the same shader does with different inputs.
  const balls: Array<[string, Surface, number]> = [
    ["chrome", { color: new Color3(0.95, 0.95, 0.95), roughness: 0.06, metallic: 1 }, 20],
    ["gold", { color: new Color3(1.0, 0.77, 0.34), roughness: 0.32, metallic: 1 }, 20],
    ["rubber", { color: new Color3(0.75, 0.08, 0.1), roughness: 0.6 }, 4],
  ];
  balls.forEach(([name, look, mass], i) => {
    const ball = MeshBuilder.CreateSphere(name, { diameter: 1, segments: 32 }, scene);
    ball.position.set(-1.6 + i * 1.6, 0.5, 5);
    ball.material = surface(scene, name, look);
    prop(ball, PhysicsShapeType.SPHERE, mass, 0.4);
  });

  // Something brighter than white, so the bloom has a job.
  const beacon = MeshBuilder.CreateSphere("beacon", { diameter: 0.6, segments: 24 }, scene);
  beacon.position.set(-8, 2.4, 6);
  beacon.material = surface(scene, "beacon", {
    color: Color3.Black(),
    emissive: new Color3(0.15, 0.6, 1),
    glow: 9,
  });
  const pedestal = MeshBuilder.CreateCylinder("pedestal", { diameter: 0.5, height: 0.6 }, scene);
  pedestal.position.set(-8, 1.8, 6);
  pedestal.material = concrete;
  solid(pedestal, PhysicsShapeType.CYLINDER);

  return { statics };
}
