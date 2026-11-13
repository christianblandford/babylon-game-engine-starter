# Hair and fur

How hair, fur and fuzzy surfaces should be done in this scaffold. Written for
whoever (person or agent) is asked to add them later.

**Status: nothing here is implemented or tested in this project yet.** The fox
is low-poly and has no hair. Every API named below was checked against the
installed packages (Babylon 9.36), but none has been run in this pipeline.
Where behaviour is an expectation rather than something observed, it says so.

## Decision

| Need | Use | Where the work happens |
|---|---|---|
| Hair, beards, manes, tails, feathers, long fur | **Hair cards** | Blender (modelling + textures) |
| Short fur, velvet, fuzzy cloth on a surface | **Sheen** on the PBR material | Blender material, or two lines of code |
| A stylised furry prop where cost doesn't matter | Shell fur (`FurMaterial`) | Code |
| Simulated strand hair | **Not available.** Don't attempt it. | — |

Default to hair cards. They are what most shipped games use, they need no new
engine code, and they already travel through this project's glTF pipeline.

## Hair cards

Flat strips of polygons, each textured with a clump of strands and an alpha
channel that cuts the clump out. Layers of them read as hair.

### In Blender

- Model the cards as part of the character mesh (or a separate mesh skinned to
  the same armature). Dozens to a few hundred cards for a head of hair.
- One material for all the hair, with a base-colour texture whose **alpha
  channel** is the strand cut-out.
- Turn **backface culling off** on that material so cards show from both sides
  (exports as glTF `doubleSided`).
- Export alpha as a **cut-out, not a blend** (glTF `alphaMode: MASK`). How the
  Blender exporter decides between MASK and BLEND depends on how the alpha
  socket is wired and has changed between Blender versions; check the glTF
  section of the Blender manual for the installed version, and confirm the
  result by reading `alphaMode` in the exported file. If it comes out as BLEND,
  fix it in code (below) rather than fighting the exporter.
- Optional, for the stretched highlight real hair has: enable **anisotropy** on
  the material. It exports as `KHR_materials_anisotropy`, which the loader
  supports.

### In the game

Nothing to do if the file says MASK: the loader turns it into an alpha-tested
`PBRMaterial` with the file's cutoff (default 0.5).

To force it after loading (for a model spawned with `spawnModel`, or the player
model in `src/game/player.ts`):

```ts
import { PBRMaterial } from "@babylonjs/core";

for (const mesh of model.meshes) {
  const material = mesh.material;
  if (material instanceof PBRMaterial && material.name === "Hair") {
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    material.alphaCutOff = 0.5;
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    material.anisotropy.isEnabled = true; // optional
    material.anisotropy.intensity = 0.7;
  }
}
```

`spawnModel` shares materials between copies of a model, so this only needs
doing once per material, not once per character.

### Why cut-out and not blend

This matters for this pipeline specifically:

- **Depth and sorting.** Alpha-tested surfaces write depth like solid ones.
  Blended cards have to be sorted back to front and still show through each
  other wrongly as the camera moves.
- **Ambient occlusion.** SSAO (`src/engine/rendererFrameGraph.ts`) works from the depth
  buffer. Blended meshes aren't in it, so they'd get no occlusion and can be
  drawn over by it.
- **Shadows.** Alpha-tested materials are expected to cast card-shaped shadows
  into the cascades with no extra setup. Blended ones cast nothing unless
  `transparencyShadow` is turned on for the shadow step (the `shadows` task in
  `src/engine/rendererFrameGraph.ts`), and then cast solid quads unless
  `useOpacityTextureForTransparentShadow` / `enableSoftTransparentShadow` are
  also set.
- **Edges.** "High" and "ultra" smooth edges with temporal anti-aliasing, which
  also calms the shimmer cut-out hair is prone to. "Low" and "medium" use MSAA
  plus FXAA, where cut-out edges will be harder; that's the accepted trade.

If the edges need to be better than that: alpha-to-coverage turns the cut-out
into MSAA coverage. It exists as an engine switch (`engine.setAlphaToCoverage`,
from `@babylonjs/core/Engines/Extensions/engine.alphaToCoverage`) but is global
state, isn't wired into this project, and is untested here. `needDepthPrePass`
on the material is the other standard tool, for blended hair that must stay
blended.

## Short fur and fuzz: sheen

For a surface that should look soft at glancing angles (short fur, velvet,
felt) without any extra geometry, use the PBR sheen lobe.

- In Blender: the Principled BSDF's Sheen inputs; exports as
  `KHR_materials_sheen`, which the loader supports.
- In code: `material.sheen.isEnabled = true; material.sheen.intensity = 0.6;
  material.sheen.color = ...`.

It costs almost nothing and works with the sky-derived lighting in
`src/engine/lighting.ts`. It will not make a silhouette look furry; combine it
with a few cards along the outline if that matters.

Babylon 9 also has an `OpenPBRMaterial` with a "fuzz" layer, and an
experimental `KHR_materials_fuzz` loader extension. This project uses
`PBRMaterial` throughout; don't mix in OpenPBR for this alone.

## Shell fur: `FurMaterial`

`@babylonjs/materials` (already a dependency) includes a fur material that
draws the mesh repeatedly in offset layers.

```ts
import { FurMaterial } from "@babylonjs/materials";

const fur = new FurMaterial("fur", scene);
fur.furLength = 0.1;
fur.furColor = new Color3(0.6, 0.4, 0.2);
fur.furTexture = FurMaterial.GenerateTexture("furNoise", scene);
mesh.material = fur;
const shells = FurMaterial.FurifyMesh(mesh, 20); // 20 extra copies of the mesh
```

Know before using it:

- **Cost.** `FurifyMesh(mesh, n)` adds `n` meshes, so `n` more draw calls and
  `n` times the triangles for that object. Every shell also has to be
  registered as a shadow caster if the fur should cast shadows.
- **Look.** It is an older, non-PBR shader. Expect it not to pick up the sky's
  ambient light and reflections the way everything else here does, and to need
  hand-tuning under the HDR tone mapping. (Expectation, not tested.)
- **Animated characters.** Not tested on a skinned mesh here. Verify the shells
  follow the skeleton before committing to it.
- **Maps.** Don't put it on map objects: the shells would defeat the mesh
  pooling and merged far versions in `src/engine/map.ts`.

Use it for one hero prop at most.

## Strand hair

There is no strand-based hair system in the installed Babylon packages, and
simulating and rendering tens of thousands of strands is not realistic in a
browser tab. If a request asks for "realistic hair", the answer is high-quality
hair cards with anisotropy.

## Hair and fur on map objects

Card-based things placed in a map (grass tufts, reeds, fur rugs) need two
custom properties in Blender, because of how `tools/blender/export_map.py`
builds the far version of each chunk:

- `lod_skip = true`. The far version bakes each material down to its flat base
  colour and drops textures, so a card would become a solid opaque rectangle in
  the distance.
- `collision = "none"`, so the player doesn't bump into grass.

Make them linked duplicates (Alt+D) so every copy across the map is drawn in
one instanced batch.

## Verifying a hair change

1. Load the model and check in the Inspector (Shift+`) that the hair material
   reads as alpha test, not alpha blend.
2. Look at it against the sky and against the ground, from both sides.
3. Check its shadow on the ground is hair-shaped, not card-shaped.
4. Toggle SSAO in the debug panel (`) and confirm no dark halo appears around
   the cards.
5. Switch the quality preset to "low" and confirm the edges are still
   acceptable without MSAA.
