/**
 * Babylon features that must be registered by importing them.
 *
 * The code imports each Babylon class from its own module
 * (`@babylonjs/core/Meshes/mesh`, not `@babylonjs/core`) so the production
 * bundle only contains what the game uses. The catch: parts of the engine
 * that are reached indirectly (a scene's physics, the shadow pass, instanced
 * drawing, glTF animation...) are no longer pulled in automatically. Each
 * line below switches one on.
 *
 * If you use a new Babylon feature and the console says something like
 * "X needs to be imported" or a method is missing at runtime, add its module
 * here.
 */

// Classes Babylon looks up *by name* at runtime instead of importing: particle
// files create textures, sub-emitters create their own emitter nodes, and
// loaded content creates animations. A lookup that finds nothing fails with
// "internalClass is not a constructor".
import "@babylonjs/core/Animations/animation";
import "@babylonjs/core/Materials/Textures/texture";
import "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Meshes/mesh";

// Particle files can drive turbulence with a noise texture, created by name
// and kept up to date by a scene component.
import "@babylonjs/core/Materials/Textures/Procedurals/noiseProceduralTexture";
import "@babylonjs/core/Materials/Textures/Procedurals/proceduralTexture";
import "@babylonjs/core/Materials/Textures/Procedurals/proceduralTextureSceneComponent";
