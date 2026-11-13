# Babylon Game Scaffold

A Babylon.js 9 + Vite + TypeScript starting point for 3D browser games.
`README.md` covers the layout, controls, map workflow and common tasks; read it
first.

## Working here

- `src/engine/` is reusable systems; `src/game/` is the game. `src/game/scene.ts`
  assembles a scene and is hot-swapped on save.
- Import Babylon classes from their own modules
  (`import { Mesh } from "@babylonjs/core/Meshes/mesh"`), never by value from
  `@babylonjs/core`: that pulls the whole engine into the bundle. `import type`
  from the root is fine. Many modules exist as `x` and `x.pure`; import `x`
  (it also registers the feature). Indirectly used features are registered in
  `src/engine/babylonFeatures.ts`.
- Anything that moves on its own advances by `ctx.clock.delta`, so pausing
  stops it. Don't read the engine's frame time directly in game code.
- Prefer Babylon's built-ins (and its `@babylonjs/addons`) over third-party
  libraries; add an outside library only where Babylon has nothing.
- Check changes with `npm run typecheck`, and in the browser: in dev builds the
  running game is on `window.game` (`scene`, `player`, `map`, `lighting`,
  `renderer`).
- Verify Babylon APIs against `node_modules/@babylonjs/*/**/*.d.ts` before
  using them. Many `.d.ts` files re-export from a sibling `*.pure.d.ts`.
- Maps are built in Blender and exported with `npm run map:export`; the
  conventions are in the README and at the top of `tools/blender/export_map.py`.
- glTF content sits under a mirrored root node (right-handed file, left-handed
  engine). Anything that decomposes a world matrix, bakes a transform or mixes
  instances from different parents has to account for that; `src/engine/map.ts`
  has the worked examples.

- Particles are unlit and the scene is HDR: effects need `brightness` (see
  `PRESET_TUNING` in `src/engine/effects.ts`). Runtime lights must go through
  the light cluster there; a plain `PointLight` created mid-game recompiles
  every material and stalls for hundreds of milliseconds.

- The default renderer is a Babylon Frame Graph (`src/engine/rendererFrameGraph.ts`).
  Things that follow from that:
  - `scene.activeCamera` is null between frames. Use `ctx.camera`.
  - Full-screen GUI must be created with `ctx.renderer.createGui(name)`, and
    shadow casters registered with `ctx.lighting.addShadowCaster(mesh)`.
  - Never give a render pass an instanced mesh it will then skip (for example a
    transparent-only pass that receives solid instances). Babylon marks the
    instance's source as handled without drawing it and never clears the mark,
    so every instance of that mesh vanishes from then on. Split the object list
    first, as the `sort` step does.
  - WebGPU caps how many values a shader may pass from vertex to fragment
    stage. The engine requests the GPU's maximum (`setMaximumLimits`), but a
    material that adds many more will fail there first, as a black screen with
    "invalid render pipeline" warnings and no JavaScript error.
  - Verify rendering changes in both renderers (`?renderer=classic`) and on
    both engines: WebGPU is the default, `?engine=webgl` forces WebGL2.

- Characters that walk get an agent from `ctx`-level navigation
  (`src/engine/navigation.ts`), never their own path code. It rebuilds itself
  when the map streams; a mesh edited in place does not trigger a rebuild, so
  pass a new mesh. `src/game/npcs.ts` is the worked example.

- Levels are listed in `LEVELS` (`src/config.ts`); `?level=<id>` starts in
  one. `tools/blender/make_test_town.py` is the reference for building a
  dense level by script: one object per block of houses, linked duplicates
  for props, Empties for everything code refers to. When you test in the
  browser, a hidden or background Browser pane throttles the page to about
  one frame a second, which looks like the game hanging.

- Three traps found the hard way in the map loader and ground cover:
  the glTF loader hands meshes with identical triangle lists the same index
  array, so anything that edits indices in place (baking a mirrored
  transform does) must copy them first, or every second mesh ends up
  inside-out and lights black; meshes drawn with thin instances must not
  share geometry (`makeGeometryUnique()` after `clone()`), or draws fail with
  "vertex buffer is not big enough"; and Blender's glTF export drops the
  alpha of a colour attribute on opaque materials, which is why the grass
  mask travels as a vertex group turned into a second UV map.

- Real surface textures are Poly Haven sets in `maps/textures/<id>/`, fetched
  with `npm run texture:get -- <id>` and turned into Blender materials by
  `surface()` in `tools/blender/surfaces.py` (tint one set rather than
  fetching several). Downloading is the user's call: ask before fetching
  new sets. The export stores colour and roughness maps as ETC1S and normal
  maps as UASTC at half size; `tools/map.mjs` drives the Basis encoder
  directly because Babylon's `KTX2Encoder` class has no compact recipe for
  roughness maps.

- Water is `src/engine/water.ts`: a PBR material swapped in for Blender
  materials named `Water` or `Sea` through `loadMap`'s `materials` option, and
  the source of `surfaceAt`, which the player's swimming state reads. Don't
  reach for Babylon's `WaterMaterial`: its render targets never run under the
  Frame Graph. Map meshes are wound the reverse of code-made ones, so any
  material you supply to a map needs `backFaceCulling = false`.

- To test movement from the browser tools when the pane is throttled, step
  the game yourself: `engine.beginFrame(); input.update(); scene.render();
  input.endFrame(); engine.endFrame()` in a loop advances it one twentieth
  of a second per call (`game.player.input` reaches the input object). The
  begin/end calls matter on WebGPU, where nothing is submitted without them.

- Linked duplicates in a map are drawn as thin instances of one pooled mesh
  (`batches` in `src/engine/map.ts`), not as Babylon instances, which cost
  CPU per copy per frame. They are static: something that must move, hide or
  be picked individually should not be a linked duplicate, or should be
  built in code at a marker.

- Trigger zones and usable things go through `src/engine/triggers.ts`; what
  they do belongs in `src/game/interactions.ts`, keyed by name. Zones are
  Havok trigger shapes reported by the physics plugin's
  `onTriggerCollisionObservable`. Don't use
  `PhysicsCharacterController.onTriggerCollisionObservable` for this: despite
  the name it reports pushes against dynamic bodies, not trigger volumes.

- Map textures are shared files compressed to KTX2 by the export
  (`tools/blender/export_map.py`); `src/engine/map.ts` hands every chunk the
  map's existing material by name so they are fetched once. The decoder is
  served from `public/babylon/ktx2/`, never a CDN. Keep
  `@recast-navigation/*` at the pinned version (0.43.0 leaks).

- The standard material is extended with plugins, never forked: tiling and
  blended layers (`src/engine/surfacePlugin.ts`), wind (`src/engine/wind.ts`),
  leaf cards (`src/engine/foliage.ts`), grass thinning
  (`src/engine/groundCover.ts`), water depth (`src/engine/water.ts`). Each
  is written twice, GLSL and WGSL; change both and test both. The PBR
  fragment hook to use is `CUSTOM_FRAGMENT_UPDATE_ALPHA` (there is no "update
  albedo"); `normalW` may be reassigned there too.

- Blender materials steer the game through custom properties (`metres`,
  `variation`, `detile`, `wind`, `foliage`, `matte`, `gain`) and objects
  through theirs (`ground_cover`, `blend_layer`/`blend_mask`, `height_map`,
  `far_mesh`, `skirt`);
  the tables are in the README and the reading code is `finish()` in
  `src/engine/map.ts`. Add a new one there rather than matching on names.

- A large wall or cliff: a texture photographed large, `surface(...,
  even=0.8)` to take out the photograph's own patches, vertex colours to
  paint patches back, and relief (the town wall in
  `tools/blender/make_test_town.py` is the worked example;
  `docs/level-building.md` section 4). The exporter hangs a hidden lip under
  sliced ground only; a sliced mesh that is right in Blender and smeared in
  game is that lip on the wrong object (`skirt = false`).

- Trees and bushes come from `tools/blender/plants.py` (leaf cards, a wind
  map in the second UV set, and picture cards of the plant as its `far_mesh`
  stand-in, which the exporter merges into each chunk's far mesh through
  the `impostor` material property). Don't fetch
  scanned trees: they are millions of triangles. Leaf materials must keep
  `twoSidedLighting = false` and no anisotropic filtering.

- The ambient light is baked once from the sky into a reflection probe
  (`bake()` in `src/engine/lighting.ts`). Three things there are load-bearing:
  the bake has its own camera at the origin (`SkyMaterial` places the sun
  relative to the active camera), `cube._shouldRender()` is called after the
  manual render (or the scene redraws the probe over its filtering), and the
  cloud layer uses separate textures for brightness and opacity (one texture
  with `level` above 1 subtracts light). If shaded ground ever sparkles or
  mirrors the sky, read the cube back with `readPixels` and look for
  negative or huge values.

- Every Frame Graph pass that draws lit surfaces is created with
  `{ enableClusteredLights: true }` (`LIT` in `rendererFrameGraph.ts`), or
  effect lights are sorted into the wrong screen tiles.

- Frame time is measured with the GPU included (`frame(); await
  engine._device.queue.onSubmittedWorkDone()`), never by timing
  `scene.render()` alone; `docs/lessons.md` "Performance" has the method and
  where the town's frame goes. Map materials are frozen once their chunk is
  set up: to change one in a way that needs another shader (a texture, alpha
  mode, a plugin), `unfreeze()` it first. A mesh drawn as thin instances over
  a wide area must describe itself to the shadow pass with `setCasterGroups`
  (`src/engine/shadowCulling.ts`), as map batches do.

- Work that happens now and then (a chunk arriving, grass, navigation) is
  what causes stutter, and it is timed: wrap new work of that kind in
  `timed("label", fn)` from `src/engine/perf.ts`, and keep it to a few
  milliseconds per frame (see how `setUpNow` in `src/engine/map.ts` and
  `plant` in `src/engine/groundCover.ts` pause). In a dev build
  `perf.recording = true`, then `perf.slowest()` and `perf.totals()` in the
  console. Never show a map mesh before its set-up is finished, never
  dispose or un-cluster a light during play, and give a level `warmUp`
  markers (`src/config.ts`) for whatever is out of sight of its spawn:
  each of those was a visible freeze.

## Guides

- `docs/lessons.md`: what building this taught, by topic. Read before
  starting a game on it; add to it when something costs real time.
- `docs/level-building.md`: how a level is put together, step by step.

- `docs/hair-and-fur.md`: how hair, fur and fuzzy surfaces should be done
  (hair cards by default), and what not to attempt.
