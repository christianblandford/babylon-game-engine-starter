# Lessons learned

What building this scaffold taught, written for whoever builds a game on it
(or another scaffold like it). Each entry is something that cost real time to
find out. Where a lesson became code, the file is named, so the code and its
comments are the detail and this is the map.

Contents: [What makes it look real](#what-makes-it-look-real) ·
[Babylon](#babylon) · [Shaders](#extending-the-standard-material) ·
[Blender and the export](#blender-and-the-export) ·
[Textures and assets](#textures-and-assets) · [Performance](#performance) ·
[Testing in the browser](#testing-in-the-browser) ·
[Choices not taken](#choices-not-taken)

## What makes it look real

In rough order of how much each one mattered:

1. **Correct lighting beats everything.** For a long time some walls were
   black whatever texture they had, because they were being lit inside-out
   (see "shared index arrays" below). Before judging a texture, check the
   surface is lit from the right side and that shade is not mud. The sky is
   the light in every shadow: with the sky too dim, shaded walls lose all
   their colour (`skyGain` in `engine/lighting.ts`; a clear sky is about a
   fifth of full sun).
2. **Gloss is why some scanned surfaces look real and others flat.** Cobbles
   and planks have roughness around 0.6, so they catch the sun. Plaster,
   stone, roof tiles and soil are 0.9 and above: physically right, visually
   dead, especially in shade where a normal map does almost nothing. Flat
   surfaces need geometry (sills, beams, frames, eaves) to cast small
   shadows; a texture alone reads as wallpaper.
   The town went from boxes to streets by adding, in order of effect:
   jettied upper floors, roof edges (overhang, barge boards, scalloped tile
   ends, ridge tiles), recessed openings with proud frames, and a plinth at
   the ground. `docs/level-building.md` has the list.
3. **Kill repetition in the shader, not by buying more textures.** A tiled
   texture across a field is found by the eye in a second. Blotches of tone
   and hue many repeats wide, plus (for organic surfaces only) a shifted
   copy shown in patches and a larger copy at distance, remove it for the
   cost of three texture reads (`engine/surfacePlugin.ts`).
4. **Paths, shores and worn ground belong in the terrain, not on it.** Strips
   laid over grass sit proud, overlap at junctions and end in ruled lines. A
   mask image blended in the terrain's own material gives sunken paths, clean
   forks and ragged edges at once.
5. **Things should sit in the ground.** Houses on stone footings that take up
   the slope, roads worn a hand's depth into the turf, grass that thins toward
   a path, props sunk a few centimetres. Anything exactly on the surface looks
   placed.
6. **Nothing should end at a line.** Grass that stops at its drawing distance,
   water that meets the bank at full strength, a path with a ruled edge: each
   is a small thing and each says "computer". Thin grass out tuft by tuft
   toward its limit, fade water by its depth, break a boundary along the
   texture's own clumps.
7. **An empty sky makes everything under it look like a model.** A cloud
   layer (one textured disc, drawn into the ambient bake as well) changes the
   whole frame.
8. **Grass is a sward, not tufts.** Dark-rooted tufts on bright ground read
   as dots. Roots close to the ground's own colour, many fine blades spread
   wide enough that neighbours run together, mostly short with the odd tall
   clump, and twice as thick near the camera as far away.
9. **Scale from real data.** Lay every scanned texture at its true size (each
   set's `info.json` gives metres per repeat). Wrong scale is the most common
   reason a good texture looks wrong.

## Babylon

- **Import from deep paths** (`@babylonjs/core/Meshes/mesh`), never by value
  from the package root: the bundle drops from 8.5 MB to about 3.2 MB.
  Features reached by name at runtime must be imported for their side effect
  (`engine/babylonFeatures.ts`); the symptom of a missing one is "X is not a
  constructor" or "is not a function" at runtime, not at build time.
- **The Frame Graph renderer changes some rules.** `scene.activeCamera` is
  null between frames; full-screen UI and shadow casters are registered
  through the renderer; a render pass given an *instanced* mesh it then skips
  makes every instance of that mesh vanish for good (split object lists
  before the pass). Material render targets and `customRenderTargets` are
  never rendered by it, which rules out anything built on them (below).
- **WebGPU has limits WebGL doesn't.** A material may pass only 16 values
  from vertex to fragment stage by default; the lit material with four shadow
  cascades and motion vectors needs 17, and the failure is a black screen
  with no JavaScript error. Ask for the device's real limits and features
  (`setMaximumLimits`, `enableAllFeatures` in `engine/createEngine.ts`);
  without the features, compressed textures are silently unpacked to full
  size.
- **The glTF loader shares index arrays between meshes** whose triangle lists
  are identical (two plain boxes). Anything that edits indices in place,
  such as baking a mirrored transform, flips the shared array once per mesh,
  leaving every second one inside-out. With double-sided materials nothing is
  culled, so the only symptom is surfaces lit black. Copy indices before
  editing them (`engine/map.ts`).
- **glTF content is mirrored.** The file is right-handed, the engine
  left-handed, so loaded content sits under a root scaled -1 on one axis.
  Meshes baked out of it are wound the opposite way to meshes made in code. A
  material made in code and put on map meshes needs back-face culling off, or
  it is culled entirely.
- **Meshes drawn with thin instances must not share geometry.** Clones share
  it by default, and the record of which instance buffers go with it is kept
  on the geometry: draws then fail with "vertex buffer is not big enough".
  `makeGeometryUnique()` after `clone()` (`engine/groundCover.ts`).
- **A light added at runtime recompiles every material**, a stall of hundreds
  of milliseconds. Effect lights go through a clustered-light container
  created up front (`engine/effects.ts`).
- **A reflection probe rendered by hand** must wait for
  `cubeTexture.isReadyForRendering()`, or it bakes an empty sky and the scene
  is unlit for its first frames.
- **`bakeCurrentTransformIntoVertices` moves vertices but not culling
  bounds**; call `refreshBoundingInfo()` after it or the mesh is culled as if
  it were still at the origin.
- **Physics takes one step per frame of the frame's length**, so cap it
  (`Scene.MaxDeltaTime`), or a hitch sends stacked objects flying.
- **The character controller's "trigger" observable is misnamed**: it reports
  pushes against loose bodies. Real trigger volumes are Havok trigger shapes
  reported by the physics plugin, and they do fire for the character
  (`engine/triggers.ts`).
- **A trigger zone reports "left" for a body the map has suspended.** Props
  registered with `map.anchor` are frozen when their ground unloads, and the
  physics engine reports that as leaving every zone they were in. A zone
  handler that cares should check where the body actually is.
- **A render target drawn by hand gets drawn again.** The ambient light is a
  reflection probe rendered once with `cube.render()` and then filtered. Used
  as `scene.environmentTexture`, it is also a render target of every material
  that reflects it, so the scene renders it once more on the next frame: from
  the game camera, and over the filtered result (the roughness chain is
  replaced by plain mipmaps). Call `cube._shouldRender()` after the manual
  render to use up its "render once". Found by reading the cube back
  (`readPixels(face, level)`) and looking for values that had no business
  there.
- **`SkyMaterial` places the sun relative to `scene.activeCamera`**, not the
  view being rendered. Baking it into a probe from the game camera shifts the
  whole sky by the camera's distance from the probe: in a level whose spawn
  is 100 m from the origin the sun sat 8 degrees outside the disc meant to
  mask it. Bake with a camera of its own at the probe's centre.
- **A texture's `level` scales its alpha too.** One texture used as both
  `emissiveTexture` and `opacityTexture`, with `level` raised for brightness,
  is more than opaque, and alpha blending then subtracts what is behind it.
  Harmless against blue sky; behind it was the sun, and the bake came out
  with pixels at minus fourteen thousand. The symptom was white and
  blue-black sparkle on shaded ground wherever a normal map tilted it toward
  the sun's mirror direction. Two textures from the same pixels.
- **Clustered lights need switching on in each Frame Graph pass**
  (`new FrameGraphObjectRendererTask(name, graph, scene, { enableClusteredLights: true })`).
  The classic pipeline sorts a cluster's lights into tiles and depth slices
  for every camera; a Frame Graph pass does it only when asked, and otherwise
  the cluster's tables stay empty.
- **`@recast-navigation` 0.43.0**, the version Babylon's navigation add-on
  loads by default, leaks memory on every navmesh rebuild; 0.44.0 does not.

## Extending the standard material

The standard PBR material can be extended without forking it, through
`MaterialPluginBase`. Three plugins here are the worked examples:
`engine/surfacePlugin.ts` (fragment: repetition and blending),
`engine/wind.ts` (vertex: sway), and Babylon's own
`Materials/ditheredTileFadeMaterialPlugin.js`.

- **Write the code twice**: GLSL for WebGL, WGSL for WebGPU
  (`getCustomCode(shaderType, shaderLanguage)`), and say so in
  `isCompatible`. In WGSL, uniforms are `uniforms.name`, varyings
  `fragmentInputs.name` / `vertexInputs.name`, and a texture is two
  declarations (`var x: texture_2d<f32>; var xSampler: sampler;`) sampled
  with `textureSample(x, xSampler, uv)`. Assign whole vectors rather than
  components.
- **The PBR fragment shader has no "update albedo" hook.** The one to use is
  `CUSTOM_FRAGMENT_UPDATE_ALPHA`, which sits immediately after
  `surfaceAlbedo` and `alpha` are set and before lighting. In the vertex
  shader, `CUSTOM_VERTEX_UPDATE_WORLDPOS` comes after `worldPos` is computed
  (instances included).
- **Uniforms** go in `getUniforms().ubo` (plus a plain declaration string for
  engines without uniform buffers) and are set in `bindForSubMesh`. Samplers
  are named in `getSamplers` and declared in `CUSTOM_FRAGMENT_DEFINITIONS`.
- **Guard injected code with a define** from `prepareDefines`, and use the
  material's own defines to know what exists (`ALBEDO`, `UV2`,
  `GAMMAALBEDO`). `vAlbedoUV` and `albedoSampler` are usable whenever
  `ALBEDO` is defined; `vPositionW` always is.
- **A vertex attribute only exists if the material asked for it.** The second
  UV map is declared only when some texture needs UVs; a plugin that reads it
  on an untextured material must set `defines._needUVs` in
  `prepareDefinesBeforeAttributes`.
- **To change a texture's contribution without losing tints already applied
  to it**, multiply the colour by `new sample / original sample` rather than
  replacing it.
- **The same hook can replace the normal.** `normalW` is already computed
  (normal map included) when `CUSTOM_FRAGMENT_UPDATE_ALPHA` runs, and
  everything after it (reflections, every light) reads it, so assigning it
  there gives a blended-in surface its own relief. Build the frame from the
  surface normal and the direction the UVs run in; and remember that in a
  glTF image "up" is toward smaller v, so the green channel is subtracted
  when v follows a world axis.
- **In a vertex shader, `finalWorld[3].xyz` is the instance's origin**, thin
  instances included. That is enough to do per-instance effects with no
  extra attribute: the grass shrinks each tuft toward its own root with
  distance, using a hash of the root position to make the edge ragged
  (`engine/groundCover.ts`).
- **Create the plugin before the material is first drawn.** Changing what it
  does later is fine (`markAllDefinesAsDirty`).
- Depth and shadow passes use other shaders: a vertex animation does not move
  the shadow, and does not appear in motion vectors.

## Blender and the export

- **Blender does not save what nothing uses.** A material no object is made
  of, a mask image no material shows: gone on save unless given a fake user.
  This silently drops blend layers and stand-in meshes.
- **The glTF exporter drops the alpha of a colour attribute** on opaque
  materials. Per-vertex data that must survive travels as a vertex group that
  the map exporter turns into a second UV map (`ground_cover`), or as a UV
  map directly (`wind`). Extra UV maps come through slicing intact.
- **Texture tinted by a colour or by vertex colours** is a Mix node set to
  Multiply between the image and the colour or Color Attribute node; the
  exporter turns that into a colour factor or vertex colours. A tint can only
  darken. To lighten, recolour the image itself (`tone=` in
  `tools/blender/surfaces.py`).
- **Occlusion** needs a node group named `glTF Material Output` with an
  `Occlusion` input. With roughness and metalness taken from the same image's
  green and blue, the exporter writes one combined texture.
- **Custom properties** on objects *and materials* arrive in the game as
  `metadata.gltf.extras`. This is how a material says how big its texture is
  (`metres`), whether to shuffle its repeats (`detile`), or that it sways
  (`wind`).
- **One object per block of buildings.** Every object costs a draw call per
  material in the main view and again in each shadow cascade. Repeated props
  are linked duplicates (drawn as instances); the exporter does not merge
  objects for you.
- **Distant versions** are merged into one vertex-coloured mesh per chunk, so
  they carry no textures and no cut-outs. Anything whose look depends on
  alpha (leaf cards) needs a `far_mesh` stand-in or `lod_skip`.
- **Generated levels are worth it.** Both test maps are Python scripts
  (`tools/blender/make_test_*.py`): reproducible, reviewable, and an agent
  can change them. Hand edits to the .blend are lost on regeneration, so
  decide per level which it is.
- Level scripts should compute the land first and set everything on it
  through one `ground(x, y)` function; clear the grass mask as roads and
  buildings are laid; create the terrain object last.

- **The exporter's hidden lip is for ground only.** Sliced terrain gets a
  3 m lip hung under its edges so that a chunk drawn in detail next to one
  drawn far shows no gap. The test for "terrain" used to be "has open
  edges". A wall built face by face, every face with its own corners, is
  open at every edge: each face got a lip of its own, carrying one row of
  the texture smeared down 3 m, in front of the wall. In game: hard
  vertical bars of stretched texture, no error anywhere, and the mesh
  correct in Blender. The test is now "open and lying mostly flat", and the
  object property `skirt` overrides it. When something is right in the
  .blend and wrong in the game, compare vertex positions and UVs of one
  face on both sides before theorising.

- **A per-vertex mask is as coarse as the mesh.** Grass cover is painted on
  terrain vertices 2 m apart and blends between them, so "bare under the
  paving" needs clearing nearly a whole grid step beyond the paving's edge,
  and the game ignores cover below a quarter. Otherwise blades come up
  through the cobbles along every street.

## Textures and assets

- **Poly Haven** (CC0) is the source for surfaces: `npm run texture:get`.
  Its *models* are film scans: shrubs and ferns are a few thousand triangles
  and usable, trees and grass are one to seventeen million and are not. Check
  the triangle count first (`npm run model:get -- --search`). Trees and
  grass are built instead.
- **Its leaf textures have no alpha**: the leaves are modelled. They cannot
  be used as cut-out cards.
- **Compression choices** (`tools/map.mjs`): colour and roughness/occlusion
  maps in compact ETC1S (about 0.2 MB at 1024 px), normal maps in
  high-fidelity UASTC because the compact form visibly damages them, and
  therefore stored at half size by default. The first export without this
  was 19 MB of textures for the town; with it, 4.5 MB. Rate-distortion
  optimisation of UASTC saved almost nothing on scanned normals.
- Babylon's `KTX2Encoder` class has no compact recipe for data maps, so the
  exporter drives the same Basis encoder directly.
- **What repeats visibly is the photograph's broad light and dark**, not its
  stones. Dividing the colour map by a heavily blurred copy of itself
  (`even=` in `surfaces.py`; the blur wraps, so it still tiles) removes
  that, and large-scale variation is then supplied by things that do not
  repeat: vertex colours, the game's `variation`. A wall-sized surface also
  wants a texture photographed large (10 m or more a repeat).
- **Scanned plants need two corrections** once cut down to hundreds of
  triangles: their leaves become large flat facets that mirror the sky
  (`matte`), and photographed leaf colour is far darker than painted grass
  (`gain`). Both are material properties `import_model` sets. Without them
  a flower is black plastic.
- **Check a set's numbers before blaming the renderer**: average roughness,
  occlusion and colour of each downloaded set are worth printing once. A set
  can be much darker or browner than its name suggests (`grass_ground` is a
  forest floor).

## Trees and foliage

`tools/blender/plants.py` builds them, `src/engine/foliage.ts` and `wind.ts`
draw them. What was learned getting from cones to trees:

- **Build trees; don't download them.** Wood as real tubes, foliage as a few
  hundred cards each painted with a whole leafy twig: about 2,400 triangles
  and one 1024 px atlas per kind of leaf.
- **Card normals point out of the crown**, not out of the card, so the crown
  shades as one volume. That only works with `twoSidedLighting` off; the
  glTF loader turns it on for double-sided materials.
- **A plain alpha cut-off makes trees go bald with distance.** The texture's
  small blurred copies hold an even 40% where the full-size one holds
  "leaf, gap, leaf"; 40% is under the cut-off and the card vanishes. The
  fix is in the shader, not the texture: as the blur grows, swap the
  cut-off for a fixed random number per patch of the card, so 40% of the
  patches survive. Leave the material's own cut-off low for the shadow
  pass, which the plugin is not part of.
- **Cull cards seen edge-on**, by the angle between the view and the card's
  true (derivative) normal. They are otherwise streaks.
- **No anisotropic filtering on leaf textures**: it sharpens exactly the
  edge-on cards that should blur away.
- **Measured leaf reflectance looks black.** A crown is brighter than its
  leaves because light comes through them; cards let none through. The
  painted colour has to be about twice the reflectance (`LEAF_GAIN`). Judge
  foliage next to sunlit grass, in the game, not in Blender's viewport.
- **A material's colour set in place does not reach the shader.**
  `material.albedoColor.set(...)` changes nothing until the material is
  marked dirty; assign a new colour. This cost an hour of wrong conclusions
  while tuning the above from the console.
- **Far away, a tree should be a picture of itself.** A lump of the right
  colour reads as a balloon. Three crossed cards textured with an
  orthographic render of the tree (emission only, with occlusion baked per
  vertex, brightness set to about 0.6 of the leaf colour because a card
  cannot shade itself) match the real tree's outline to within about a
  tenth. All plants share one atlas with a white patch in it, which lets
  the cards go into each chunk's single far mesh and single far material:
  everything that is not a card maps to the white patch. No extra draws.
- **Light through leaves has to be faked without shadows.** Babylon's
  translucency is real but the crown shadows itself, which cancels it. A
  term added at `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` (leaf colour
  x a yellow-green tint x how nearly the view points at the sun x how far
  the surface is turned from it) gives the glowing fringe; the vertex
  colours that darken a crown's inside keep it out of the middle.
- **No specular on leaves at all** (`metallicF0Factor = 0`): even a little
  puts a white rim of reflected sky on every crown seen against the light.
- **Bark must sway with the leaves**: the wind's weight runs from 0 at the
  foot of the trunk to 1 at leaf tips, in the second UV map, and bark and
  leaf materials both carry `wind`.
- **Scanned ground plants** (ferns, shrubs, weeds) come as several plants per
  file, at real size (centimetres), with materials marked cut-out whose
  textures have no alpha. `import_model` picks one, makes it opaque and
  two-sided, and adds the wind map.

## Performance

- **A mesh placed many times must be stored once.** The first export with
  real trees was 114 MB: each chunk file held its own copy of every tree in
  it. Shared meshes now go once into the always-loaded file, and chunks hold
  a one-triangle placeholder per placing that names the mesh.

- **Measure the whole frame, GPU included.** Timing `scene.render()` on
  WebGPU measures only how long it takes to *hand over* the frame; the GPU's
  share is invisible. For a long time the notes here said "limited by the
  CPU, 12 ms a frame" while the game ran at 35 fps. The honest number is
  `frame(); await engine._device.queue.onSubmittedWorkDone()`, timed from
  before the frame to after the promise. On the test machine (integrated
  GPU) a town frame was 11 ms of CPU plus 10 to 25 ms more, and the two add
  up rather than overlap. To see what resolution costs, change
  `engine.setHardwareScalingLevel` and measure again: here about 5 ms per
  million pixels, so a full-window Retina canvas costs twice a small pane.
- **Then find out what the time is spent on by switching things off**, one
  at a time, with the same measurement: `task.disabled = true` on a Frame
  Graph post-process, `setEnabled(false)` on a family of meshes, emptying
  the shadow task's caster list. The town's 27 ms at 2.25 million pixels
  came apart as: ambient occlusion 4, shadow casting 4 (of which batched
  props 2.2), terrain 2.4, houses 2, batched props in the main view 3,
  anti-aliasing 1.3, sharpening 0.8, bloom 0.5, every fire and smoke column
  together under 1.
- **Ambient occlusion's blur is its cost.** Babylon's SSAO blurs with 16
  taps each way; at full resolution that was most of 4 ms. Half-size blur,
  8 taps and 8 samples took it under 2 with no difference visible in a
  screenshot (temporal anti-aliasing averages the noise).
- **Freeze static materials** (`material.freeze()`): an unfrozen PBR
  material recomputes, for every draw, whether it needs a different shader.
  1 ms a frame in the town. Plugin values (wind time), colours and lights
  still update; changes that need another shader are ignored until
  `unfreeze()`. The map does it for its own materials once a chunk is set up.
- The CPU's work follows the **number of meshes the scene has to consider**
  and the number of draws, not triangles.
- **A Babylon instance is a mesh.** `createInstance` saves draw calls, not
  CPU: every instance is still found, culled and copied into a buffer each
  frame, in the main view and again in each shadow cascade, about 5
  microseconds apiece. The island's 1,200 trees and plants cost 6.5 ms a
  frame that way. Static things belong in **thin instances**: one fixed
  buffer of placings per mesh, rebuilt when a chunk loads or unloads
  (`batches` in `engine/map.ts`). Frame time went from 15.5 ms to 9.5 ms.
  The price is that all of them are drawn, in view or not; the GPU went from
  0.2 ms to 4 ms and did not care.
- **An instance copies its source's bounds when it is made**, and a mesh with
  thin instances has bounds spanning all of them. Creating an instance from
  such a mesh (to size a collider from, say) yields an object the size of the
  map; here that fed the navigation mesh builder and killed the tab without
  an error. `buildBoundingInfo` with the mesh's own extent puts it right.
- **Thin instances need their "previous" buffer set by hand when motion
  vectors are on** (temporal anti-aliasing). Babylon makes its own copy of
  the matrix buffer the first time and never resizes it; replace the list
  with a longer one and every frame on WebGPU is rejected ("write range does
  not fit"), which shows as a frozen picture under a live HUD. Call
  `thinInstanceSetBuffer("previousMatrix", sameData)` alongside `"matrix"`.
- **Babylon draws every shadow caster into every cascade.** With four
  cascades that was 930 of the town's 1,195 draw calls. A cascade's render
  target takes a `getCustomRenderList` callback; handing each cascade only
  the casters inside its box's four sides (as seen from the sun) brought the
  frame to 808 draws with identical shadows (`engine/shadowCulling.ts`).
  A thin-instance batch defeats that test (its bounds are the whole map), so
  the map tells the shadow pass where each chunk's placings are and how big
  one is; the batch is skipped by cascades none of its groups reach, and by
  cascades whose texels are too coarse to show one placing. Another 100
  draws.
- **Profile by render step before optimising.** Wrapping each Frame Graph
  task's `_execute` in a timer took five minutes and showed the frame was
  40% main pass, 35% shadows, 5% culling, and nothing else worth touching.
  An earlier guess (that instances were cheap and triangles the problem)
  was exactly backwards.
- **Time frames properly.** On WebGPU, `scene.render()` alone, without
  `engine.beginFrame()` and `endFrame()`, never submits its work, and the
  numbers mean nothing. To see whether the GPU is the limit, await
  `device.queue.onSubmittedWorkDone()` after a batch of frames and divide.
- Grass (27,000 tufts in about 75 draws) costs nothing measurable.
- Freezing world matrices made no measurable difference here. (Freezing
  materials did, once measured per render step: see above.)
- SSAO at more than one sample per pixel halves the frame rate.
- Cascaded shadows multiply draw calls by the number of cascades; the
  material count per object is the multiplier to watch.
- Navigation rebuilds a few 8 m tiles per frame within a 3 ms budget and
  costs nothing once settled.
- Measure with whole frames timed in a loop (`engine.beginFrame();
  scene.render(); engine.endFrame()`), not the frame counter: the embedded
  browser pane throttles animation frames (see below).

## Stutter

Average frame time said the town ran at 90 frames a second. Running into it
felt bad anyway: freezes of over a second the first time, and a hitch every
few seconds after that. Averages do not show this; a recording of every
frame's time during a scripted run does (`engine/perf.ts`, and the harness
described under "Testing in the browser"). What it found, largest first:

- **A shader the game has not drawn yet costs time on first sight**: about
  17 ms of script each on WebGPU even when the browser has it cached, and a
  tenth of a second or more each when it does not. A town seen for the first
  time at a run was 2 s of freezes. Fix: `warmUp` on the level (config.ts)
  names markers to look around from behind the loading screen.
- **Anything that changes a mesh's shader variant mid-stream doubles the
  shaders.** Chunk meshes drawn for a few frames before their transform was
  baked (they sit under a mirrored root until then) needed a second version
  of every shader: 24 extra compiles per run. Temporary instances did the
  same. Nothing from a chunk is visible now until its set-up is done.
- **Chunk set-up is 20 to 50 ms a chunk**, nearly all of it collision
  shapes (up to 11 ms for one block of houses), and two chunks often arrive
  together. It now runs one file at a time, a few milliseconds per frame,
  pausing between individual shapes; flat out only while something is
  waiting on `whenLoadedAround`.
- **Planting grass on a new piece of ground is 15 to 30 ms** in one go. It is
  now a generator advanced 2 ms per frame.
- **Removing or disposing a light re-checks every material in the scene**
  (40 to 60 ms), even a light inside a light cluster. Effect lights are now
  switched off and reused, never removed (`engine/effects.ts`).
- **Navigation tiles**: one 8 m tile in a built-up street takes up to 10 ms
  and at least one is built per frame during a rebuild. 6 m tiles and a
  1.5 ms budget keep it under the frame.

- **Starting several placed effects in one frame**, as a street of
  chimneys comes into range together: they now start one at a time.
- **Putting a light into a light cluster costs the same as taking one
  out**, so a handful are made while the level loads and parked.
- **WebGL2 is half the speed of WebGPU on this scene** (median frame 26 ms
  against 12 ms, same machine, same content): each draw call is translated
  for the system's graphics API inside the browser. WebGPU is now the
  default engine where the browser has it.

Result on the same run (spawn to market square, about 1,800 frames, WebGPU,
warm browser cache): frames over 20 ms: 55 -> 15 to 30; 99th-percentile
frame 28 ms -> 20 to 22 ms; frames over 50 ms: 1 -> 0; worst frame 116 ms ->
40 to 60 ms (one frame per run, in which the far version's material is
prepared again for a newly arrived far chunk; not yet tracked down). Cold,
the worst was 1,268 ms before; the warm-up now takes that behind the
loading screen, at the price of a few seconds more loading.

What is left: a single collision shape for a block of houses still costs up
to 11 ms. Collision meshes simpler than the visible ones (a `Colliders`
collection in Blender) would remove that and make physics cheaper too.

## Testing in the browser

When a lighting fault resists explanation, stop theorising and bisect with
the material's own dials from the console: `environmentIntensity` (the sky's
share), `directIntensity` (lights), `specularIntensity`, then the textures
one at a time. Three wrong theories about the sparkle above each took longer
than that would have.

- **To find stutter, record a run.** Stop the engine's own loop
  (`engine.stopRenderLoop()`), hold a key down with a synthetic
  `KeyboardEvent`, steer by setting `game.player.yaw` toward waypoints, and
  time every `beginFrame(); input.update(); scene.render(); input.endFrame();
  endFrame()` plus the gap after it (yield with a `MessageChannel`, which is
  not throttled like timers are). Set `perf.recording = true` first and match
  slow frames to `perf.entries` by time. Wrapping each Frame Graph task's
  `_execute`, and `engine.createPipelineContext` (one call per new shader),
  names the rest.
- **A hidden or background pane throttles the page to about one frame a
  second.** With the simulation step capped, the game then runs in slow
  motion, which looks exactly like a hang or a stuck character. Step the game
  yourself instead: `input.update(); scene.render(); input.endFrame()` in a
  loop advances one twentieth of a second per call
  (`game.player.input` reaches the input object).
- Keys can be held with synthetic `keydown` events on `window`; the mouse
  with a `pointerdown` on the canvas followed by `mousemove` events carrying
  `movementX/Y`.
- Hide the loading overlay (`#loading`) before a screenshot when stepping by
  hand; its fade is driven by real time.
- Re-exporting a map while a page is loading it produces one-off "could not
  be decoded" errors. Reload before believing them.
- The console buffer survives reloads. Capture errors from a fresh
  `console.error` hook rather than reading the buffer.
- Manual stepping with a moving camera leaves temporal anti-aliasing ghosts
  in screenshots; they are an artefact of the stepping.
- **A hidden pane's screenshots go stale**, sometimes by one move, sometimes
  for good: the page stops presenting frames. Two captures that are
  identical mean the first was stale. What always works is reading the
  canvas yourself: render one frame by hand and call
  `canvas.toDataURL("image/jpeg")` in the same task (on both engines the
  picture is only there until the task ends), then get the bytes out of the
  page, for example by posting them to a ten-line local HTTP receiver that
  writes them to a file.
- **Blender returns an image's pixels as stored** (display-encoded for an
  8-bit sRGB file), not as linear light, whatever the colour space setting
  says. Convert before doing arithmetic on them and convert back before
  writing; skipping the first half washes the picture out.
- **A pooled mesh's `thinInstanceGetWorldMatrices()` leaves out the map's
  mirror**: its X is negated. To find an instance in the world, apply the
  mesh's own world matrix to the stored matrix's translation.
- The player's `pitch` is positive looking down.
- Check every rendering change three ways: default (WebGPU),
  `?renderer=classic`, and `?engine=webgl`. Shader plugins especially: the
  GLSL half is only exercised on WebGL2, the WGSL half only on WebGPU.

## Choices not taken

- **Babylon's `WaterMaterial`**: draws the scene twice more per frame through
  render targets the Frame Graph never runs, and is not physically based.
  Water here is the standard material set up as water (`engine/water.ts`).
- **Babylon's atmosphere add-on** (`@babylonjs/addons/atmosphere`): built
  around the classic pipeline's rendering groups and its own depth texture.
  The sky here is `SkyMaterial` baked into the ambient light, plus a cloud
  layer.
- **Babylon's navigation worker**: switched off in 9.36; generation runs on
  the main thread in small slices.
- **`TerrainMaterial` / `MixMaterial`** from the materials library: not
  physically based, so they would not match the rest of the scene under HDR
  lighting. Terrain uses the standard material plus the surface plugin.
- **Scanned trees**: far too heavy (above).
- **Baked light maps**: not needed for an outdoor daytime scene with a moving
  sun; they would matter for interiors, night scenes with many lamps, or
  phones.

## What still looks weak

An honest list, roughly in the order a visitor notices them. Each is a place
to spend the next day.

- **Distant trees are pictures.** Beyond the detail distance a tree is three
  crossed cards showing a render of itself. Far better than the plain lump
  it replaced, but lit the same from every side (no bright and shaded half),
  and lopsided crowns come out symmetric. Seen at the hand-over distance on
  open ground, the change is still noticeable.
- **Light through leaves is a glow, not a simulation.** It is added by view
  angle and ignores what is in the way, so a crown standing in a building's
  shadow glows as if it were in the sun.
- **Grass is one kind of plant.** Flowers now grow in patches among it, but
  the grass itself has no seed heads and no change of species with ground.
  It also does not bend under the player.
- **Roof planes are flat between their edges**, and cloth (awnings, stall
  covers) is flat colour.
- **Shade in streets is a guess.** Ambient light is the sky plus a constant
  lift (`environmentIntensity` 1.45), not light bounced off the sunlit wall
  opposite. A street lit only by a bright facing wall will look too dark.
- **Windows show nothing behind them** and reflect only the sky.
- **Water has no foam at the shore and no caustics**, and nearby objects are
  not mirrored in it.
- **Shadows do not sway** with the wind, and motion vectors ignore it, so
  leaves blur very slightly under temporal anti-aliasing in a strong gust.
- **The fox** is the low-polygon sample model it always was.
