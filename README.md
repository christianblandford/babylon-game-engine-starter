# Babylon Game Scaffold

A starting point for 3D browser games: Babylon.js 9, Vite and TypeScript, with the
rendering, physics, input, audio and debug plumbing already wired together.

```bash
npm install
npm run dev
```

Open the printed URL. Edit anything under `src/game/` and the world rebuilds in
place — no page reload, the engine keeps running.

## What's included

| Area | What you get | Where |
|---|---|---|
| Rendering | PBR materials on Babylon's Frame Graph: cascaded shadows (each cascade drawing only the casters that can reach it), HDR with ACES tone mapping, bloom, SSAO, temporal anti-aliasing, vignette, with the whole frame laid out as one readable list of steps. The older camera-pipeline renderer is kept as a fallback. | `engine/renderer.ts`, `engine/rendererFrameGraph.ts`, `engine/rendererClassic.ts` |
| Lighting | Procedural sky with a drifting cloud layer, sun with cascaded shadow maps, and ambient light + reflections baked from that same sky. Move the sun and everything follows. No HDR files. | `engine/lighting.ts` |
| Physics | Havok (WASM), loaded once and reused across scene reloads. | `engine/physics.ts` |
| Player | First- and third-person character controller on Havok's character controller, with mouse look, camera collision, automatic stepping over low ledges, swimming, gamepad support, and idle/walk/run/airborne animation blending. | `game/player.ts` |
| Ground cover | Grass planted by the game wherever the map's ground asks for it, as thickly as a painted mask says, tinted by the ground beneath, thicker close to the camera. Thousands of tufts in a handful of draw calls. | `engine/groundCover.ts` |
| Surfaces | What stops a tiled texture looking tiled: every map material gets broad patches of light and hue, an optional second scale of the same texture that takes over with distance, and an optional second material blended in through a painted mask (a worn path, rock on steep ground). | `engine/surfacePlugin.ts` |
| Trees and plants | Trees, bushes and hedges built for games: real wood carrying cut-out leaf cards, about 2,400 triangles a tree, with a plain stand-in for the distance and a wind map. Leaves keep their fullness far away and edge-on cards are cut. Scanned ferns and shrubs for the ground. | `tools/blender/plants.py`, `engine/foliage.ts` |
| Wind | Grass and leaves sway in gusts that roll across the land. Done in the vertex shader from weights stored in the mesh, so it costs nothing per plant and works for instanced ones. | `engine/wind.ts` |
| Water | Seas, moats and ponds: a surface that reflects the sky and sun, with drifting ripples, see-through from above and mirror-like toward the horizon, thinning to nothing where it meets the shore. The player floats and swims in it. One ordinary draw call, no extra passes. | `engine/water.ts` |
| Maps | Worlds built in Blender, exported as chunks and streamed around the camera: full detail with collision up close, one-draw-call stand-ins in the distance. Anything placed many times (trees, props, window frames) is stored once and drawn as one static batch. Includes a test town and a test island. | `engine/map.ts`, `tools/blender/` |
| Navigation | Where characters can walk, worked out from the loaded world as it streams (Recast, through Babylon's navigation add-on), with path finding and crowds of agents that avoid each other. Three wandering foxes show it off. | `engine/navigation.ts`, `game/npcs.ts` |
| Doors and interiors | Places joined by doors placed in Blender. An interior (a hall, a shop, a cellar) is its own small map, loaded beside the level as the player walks up and entered behind a fade of about half a second; walking back out is as quick, because the level outside is held, not unloaded. A door to another level rebuilds the scene behind the loading screen and arrives at the marker the door names. Each place has its own light: how much sun, sky and haze reach it. | `engine/spaces.ts` |
| Saved world | What the player has changed (a gate lowered, a fire put out) and where they are, kept across levels and saved in the browser as it changes, on Babylon's `DataStorage`. "Continue" and "New game" in the main menu. | `engine/worldState.ts` |
| Triggers | Zones that report what walks in and out (Havok trigger shapes, so they also notice loose props), and things the player uses with the interact key, with an on-screen prompt. Placed in Blender or added in code; game code reacts by name. | `engine/triggers.ts`, `game/interactions.ts` |
| Game shell | Main menu, pause, settings (quality, volume, look sensitivity) and level select, in Babylon GUI. Pausing freezes physics, animation and particles. | `game/shell.ts`, `engine/clock.ts`, `engine/settings.ts` |
| Effects | Particle effects by name: code-defined bursts (dust, sparks), particle files from Babylon's editor, a campfire with flickering light, rain. Placeable in Blender. | `engine/effects.ts` |
| Models | glTF/GLB loading with per-scene caching and cheap instancing. | `engine/assets.ts` |
| Input | Action map (`jump`, `sprint`, …) fed by keyboard, mouse and gamepad; pointer lock; rebindable. | `engine/input.ts` |
| Audio | Babylon's audio engine, file loading, plus synthesised placeholder effects. | `engine/audio.ts` |
| UI | Babylon GUI HUD drawn after post-processing; labels that follow meshes. | `game/hud.ts` |
| Quality | `low` / `medium` / `high` / `ultra` presets covering resolution, shadows, SSAO and anti-aliasing. | `config.ts` |
| Debug | Tuning panel, Babylon Inspector, physics collider view, live stats, and a stopwatch for the occasional work that causes stutter (`perf` in the console). Dev builds only. | `engine/debug.ts`, `engine/perf.ts` |

## Layout

```
src/
  main.ts            boots the engine, runs the frame loop, connects the menus to the game
  config.ts          quality presets, asset URLs and the level list
  engine/            reusable systems — rarely needs editing
  game/              your game — start here
    scene.ts         assembles a level from the systems
    shell.ts         main menu, pause, settings, level select
    level.ts         demo props built in code (replace with yours)
    player.ts        the character controller
    npcs.ts          demo foxes that wander and follow (replace with yours)
    interactions.ts  what this level's zones and usable things do (replace with yours)
    hud.ts           in-game UI
public/assets/       models, textures, sounds (served as-is)
public/maps/         exported maps (generated; commit them so the game runs without Blender)
public/babylon/ktx2/ Babylon's decoder for compressed textures (generated by the map export; commit it)
maps/                source .blend files
maps/textures/       surface texture sets (colour, normal, roughness), fetched with `npm run texture:get`
maps/models/         scanned small plants and props, fetched with `npm run model:get`
tools/blender/       the Blender export script, the test-map generators, and helpers for surfaces and plants
docs/                guides, and `lessons.md`: what building this taught, for whoever builds on it
```

`game/scene.ts` builds a `GameContext` (`engine/context.ts`) — the scene, camera,
input, lighting and audio — and passes it to each system. New systems should
take the context the same way.

## Controls

| | |
|---|---|
| Click | capture the mouse (Esc releases) |
| W A S D / left stick | move |
| Mouse / right stick | look |
| Shift | run |
| Space / A button | jump |
| V / right-stick click | first ↔ third person |
| Esc / P / Start | pause menu |
| Mouse wheel | zoom (all the way in becomes first person) |
| `` ` `` | debug panel |
| ``Shift+` `` | Babylon Inspector |

## Maps from Blender

Build the world in Blender, then:

```bash
npm run map:export -- maps/my_map.blend
```

That writes `public/maps/my_map/` (a `map.json` manifest, two small `.glb`
files per chunk, `global.glb` for what is always loaded, and the map's
textures in `textures/`). Add it to `LEVELS` in `src/config.ts`, or point an existing
level's `map` at the manifest, and reload. Blender is found automatically on macOS and Windows; otherwise set
`BLENDER=/path/to/blender`.

The scaffold ships with two test maps, each generated by a script and worth
opening in Blender to see how a map is put together:

- **Test Island** (`npm run map:make-test`, `maps/test_island.blend`): open
  terrain, forest, sea, long views.
- **Test Town** (`npm run map:make-town`, `maps/test_town.blend`): a walled
  town on uneven ground, with a moat and bridge, cobbled streets that climb
  to a hall on a rise, alleys, stairs up to a wall walk, a market, a working
  gate, a duck pond, and outside it a winding dirt road, trails, ponds, a
  farm, shrubs, flowers, boulders and grass. It is built the way a
  dense level should be: each block of houses is one object, repeated props
  are linked duplicates, and Empties mark every zone, usable thing, effect
  and named point. Start in it with `?level=town`.

**How it stays fast**

- The world is cut into a grid (64 m by default, `--chunk N` to change). Only
  chunks within the view distance are in memory.
- Nearby chunks load at full detail with collision and shadows. Distant ones
  load a *far version*: everything in the chunk decimated and merged into one
  mesh with one material, so each costs a single draw call.
- Big meshes such as terrain are sliced along chunk borders automatically, with
  normals carried over so the cuts don't show.
- Linked duplicates (Alt+D) are pooled: one mesh for the whole map, drawn in a
  single instanced batch however many chunks they span. Use them for trees,
  rocks, props — anything repeated. The mesh itself is stored once, in the
  map's always-loaded file; a chunk only records where each copy stands.
- Materials with the same name are shared across chunks.
- Textures are written once per map and compressed to KTX2, which stays
  compressed in video memory. However many chunks use a texture, it is
  downloaded once and held once, and freed when the last chunk using it
  unloads.
- View distance comes from the quality preset; fog is matched to it so the
  edge of the loaded world fades out.

**Conventions in the .blend**

| | |
|---|---|
| Empty named `spawn` | where the player starts (its −Y axis is "forward") |
| Any other Empty | a marker: `map.marker("name")` gives position, facing and custom properties |
| Empty with an `fx` property | a particle effect that runs while the player is near (e.g. `fx = "campfire"`; optional `fx_scale`) |
| Empty with a `trigger` property | a zone, named by the property's value. Its volume is the Empty as drawn: display it as a Cube or Sphere and scale it to fit (it can turn about the vertical axis, not tilt) |
| Empty with a `door` property | a door to another place: `door = "hall#entrance"` is the marker `entrance` in the level whose id is `hall` (`door = "back"`: wherever the player came in from). Used with the interact key; optional `prompt` and `radius`. With `walk = true` it is a zone that takes whoever walks in, sized like a `trigger` |
| Empty with an `interact` property | something the player can use, named by the value. Optional `prompt` (the text shown) and `radius` (reach in metres, default 2) |
| Object property `ground_cover` (any name, e.g. `grass`) | the game plants grass on this object. Paint where in Weight Paint mode, in a vertex group named `ground_cover` (1 thick, 0 bare); without the group it grows everywhere |
| Material named `Water` or `Sea` | drawn as water (see "Add water"). `Water` is clear enough to see the bottom; `Sea` is opaque, for open water whose floor isn't modelled |
| Collection named `Colliders…` | invisible, collision-only geometry |

Per-object custom properties (Object Properties → Custom Properties):

| Property | Values | Effect |
|---|---|---|
| `collision` | `mesh` `convex` `box` `sphere` `cylinder` `none` | physics shape (default `mesh`; `box` for linked duplicates) |
| `collision_radius` | metres | radius for `sphere` / `cylinder` |
| `collider_only` | true | invisible, collision only |
| `shadows` | false | don't cast shadows |
| `always_loaded` | true | never unloads (water, skyline) |
| `split` | true / false | force or forbid slicing along chunk borders |
| `skirt` | true / false | force or forbid the hidden lip hung under the edges of each sliced piece, which covers gaps between a chunk drawn in detail and a neighbour drawn far. By default only open, mostly flat sheets (ground) get one |
| `lod_ratio` | 0–1 | triangles kept in the far version |
| `lod_skip` | true | leave out of the far version |
| `far_mesh` | a mesh's name | that mesh stands in for this object far away, instead of a thinned copy of itself (crossed picture cards for a tree made of leaf cards, which would thin into confetti). If its material has the property `impostor`, its texture and UVs are kept in the far version; otherwise it becomes plain colour like everything else far away |
| `ground_cover` | a name, e.g. `grass` | the game plants grass on it (see above) |
| `blend_layer`, `blend_mask` | a material's name, an image's name | a second material blended into the object's own where the image is white: a path worn into grass, rock on a slope (see "Shape the land") |
| `height_map` | true | this object is the lie of the land; its height is baked into an image the game reads (water uses it to tell shallows from depths). Put it on the terrain |

Per-material custom properties (Material Properties → Custom Properties):

| Property | Values | Effect |
|---|---|---|
| `metres` | number | how much ground one repeat of the texture covers (`surface()` sets it from the texture set) |
| `variation` | 0–1 | strength of the broad light and hue patches that hide tiling (default 0.55; 0 turns them off) |
| `detile` | 0–1 | mixes in a shifted and a much larger copy of the texture, the larger taking over with distance. For ground and other wide surfaces; costs two more texture reads |
| `wind` | number | the material's plants sway; the value scales how much. The mesh needs a second UV map holding sway weight and phase (`tools/blender/plants.py` writes it) |
| `matte` | true | almost no mirror-like reflection. Set by `plants.py` on scanned plants, whose flat-faceted leaves otherwise mirror the sky like plastic |
| `gain` | number | multiplies the material's colour; above 1 brightens, which a Blender tint cannot. Scanned plants get 1.6 to sit with the painted grass and trees |
| `foliage` | true | leaf cards: lit by the normals stored in the mesh on both sides, no sharpening at shallow angles, little gloss. Set by `plants.py` on its leaf materials, with `alpha_cutoff` |

Anything else you add comes through as `mesh.metadata.gltf.extras`.

**In code**

```ts
const map = await loadMap(ctx, level.map, { viewDistance: quality.viewDistance });
await map.whenLoadedAround(position);   // before spawning or teleporting somewhere
map.anchor(aggregate.body);             // movable props: frozen, not lost, while their ground is unloaded
map.marker("spawn_pier");               // look up a Blender Empty
```

**Limits to know about**

- Far versions carry no textures, except the one atlas of plant pictures; a
  textured surface gets its texture's average colour.
- Texture compression needs Node and `npm install` at export time; without
  them the export falls back to shared PNG/JPEG files and says so. Textures
  are capped at 2048 px (`--max-texture-size N`, at most about 12.5 megapixels
  each). `--texture-quality 1-255` trades size for quality, and `--no-ktx2`
  turns compression off.
- Normal maps are stored at half size by default. They are the one kind of
  texture the compact format visibly damages, so they are kept in the
  high-fidelity one, which costs about 1.3 MB each at 1024 px; at half size
  that is a third of a megabyte. `--normal-scale 1` keeps them whole. A
  surface with colour, normal and roughness at 1024 px comes to about 0.65 MB
  to download.
- A material used by linked duplicates stays loaded for the life of the map,
  because the pooled mesh holds it.
- Each object costs one draw call per material in the main view and in each
  shadow cascade, so join neighbouring buildings into one object, as the test
  town does. The exporter does not merge objects for you.
- Maps are static geometry: no animation, armatures or lights are exported.
  Light the world with the sun/sky; spawn animated things from code at markers.
- `--draco` shrinks files further but needs Babylon's Draco decoder set up.

## URL options

- `?quality=low|medium|high|ultra` — force a quality preset.
- `?engine=webgl` — use WebGL2 instead of WebGPU. WebGPU is the default where the browser supports it (about twice the frame rate on the test town); without it the game falls back to WebGL2 by itself.
- `?renderer=classic` — use Babylon's older post-process pipelines instead of
  the Frame Graph (same look; useful for comparing, or if a platform misbehaves).
- `?debug` — load the debug tools in a production build.
- `?level=island|town|flat` — start in a particular level (ids from `LEVELS`
  in `config.ts`). `?level=town/hall` starts inside one of its interiors.
- `?continue` — pick the saved game up where it was. `?newgame` — forget it first.
- `?menu` — in development the game starts straight in the level; this shows
  the main menu first, as players see it.

## Common tasks

**Add a model.** Drop a `.glb` in `public/assets/models/`, add its URL to
`ASSETS` in `config.ts`, then:

```ts
const tree = await spawnModel(scene, ASSETS.tree, "tree");
tree.root.position.set(4, 0, 2);
tree.meshes.forEach((mesh) => ctx.lighting.addShadowCaster(mesh));
```

**Give something physics.**

```ts
new PhysicsAggregate(mesh, PhysicsShapeType.BOX, { mass: 5 }, scene); // mass 0 = static
```

**Add an input action.** Add it to the `Action` type and both binding tables in
`engine/input.ts`, then read it with `input.isDown("fire")` or
`input.wasPressed("fire")`.

**Play a sound.** `await audio.load("hit", "/assets/sounds/hit.ogg")` once, then
`audio.play("hit")`.

**Add a rendering effect.** The frame is the list of steps in
`engine/rendererFrameGraph.ts`: each step is a task whose input is the previous
step's output. Create the task (Babylon ships temporal anti-aliasing, depth of
field, screen-space reflections, volumetric light and more under
`@babylonjs/core/FrameGraph/Tasks`), set its `sourceTexture` to the current
`colour` handle, add it, and continue the chain from its `outputTexture`.
Expose anything tunable through `RenderControls` so the debug panel picks it up.

**Add a level.** Export its map, then add an entry to `LEVELS` in `config.ts`
(`map: null` gives an empty flat ground). It appears in the Levels menu, and
`game/scene.ts` receives it as `host.level`. Besides the map, a level can set
`detailDistance` (how far full detail reaches; a town wants more than the
default one and a half chunks), `sunDirection` (so the light suits the
layout), `demoProps: false` (to leave out the scaffold's platform, crates
and balls) and `warmUp` (markers to look around from behind the loading
screen, so the shaders for what is there are compiled before play: name a
spot in the middle of anything out of sight of the spawn, or the first run
toward it stutters).

**Add an interior.** Build it as its own map, around the origin, closed on
every side (walls with thickness, a roof): the sun stays on indoors and must
only get in through the windows. Give it Empties named `spawn` and
`entrance`, and one with `door = "back"` at the way out. Export it with no
far versions and a chunk size larger than the room (`make-hall` in
`tools/map.mjs` is the model; `tools/blender/make_town_hall.py` and its
helpers in `tools/blender/kit.py` are the worked example). An interior
belongs to a level, and is kept with it: its files go inside the level's own
folder (`public/maps/test_town/interiors/hall/`) and it is listed inside the
level's entry in `LEVELS`:

```ts
{
  id: "town", name: "Test Town", map: "/maps/test_town/map.json",
  interiors: [{ id: "hall", name: "Town Hall", map: "/maps/test_town/interiors/hall/map.json" }],
},
```

Then put an Empty with `door = "hall#entrance"` where its door is in the
level outside. That is all: the interior loads when the player comes within
30 m of the door. `environment` on the entry sets its light (`sun`,
`ambient`, `fog`, `exposure`, as shares of the level's own; interiors start
from `INDOORS` in `engine/spaces.ts`). `?level=town/hall` starts inside it,
for working on it.

Rooms off rooms, a cellar under the hall, a cave system: each is another
interior of the same level, joined by doors like any other (`door =
"hall/cellar#stairs"` on an Empty inside the hall; `door = "back"` in the
cellar). The list stays flat, because places joined by doors are a web and
not a tree (a cave can open into the cellar and onto the hillside); show
what belongs to what in the id and the folder: `hall/cellar` in
`interiors/hall/cellar/`. Every interior that has been entered stays loaded
until the level is left.

**Send the player somewhere from code.** `spaces.travel("hall#entrance")`,
`spaces.travel("island#spawn_pier")` (another level: the scene is rebuilt), or
`spaces.travel("back")`. `spaces.preload("hall")` loads an interior early;
`spaces.onTravelled` fires on arrival; `spaces.current` is where the player is.

**Remember something the player did.** A level is rebuilt every time it is
entered, the way its map says. What should stay changed goes in the world
state (`engine/worldState.ts`), which outlives scenes and is saved in the
browser as it changes:

```ts
state.set("gate.lowered", true);          // in interactions.ts, `state` is already this level's corner
if (state.get("gate.lowered", false)) ...  // read it back when the thing is built again
```

Names are `<thing>.<property>`; `ctx.state` is the whole of it
(`ctx.state.scope("town")`, or `"town/hall"` for an interior, gives a
place's corner). The gate and the fires in `game/interactions.ts` are the
worked examples. Where the player is (level, place, spot) is stored the
same way, under `player/`, every couple of seconds; the main menu offers
**Continue** and **New game** when there is something stored.

**Make something respect pause.** Advance it by `ctx.clock.delta` (seconds this
frame; 0 while a menu is up) instead of the raw frame time. Physics, animation
and particles are frozen for you.

**Add a setting.** Add a field to `Settings` in `engine/settings.ts` (it is
saved in the browser automatically), a control in the settings screen in
`game/shell.ts`, and apply it in `applySettings` in `game/scene.ts`.

**Give the character a jump animation.** Name the clip in `MODEL.clips.air` in
`game/player.ts`. Without one (the fox has none) the player holds a frame of
the run cycle while airborne.

**Give a surface a real texture.** Photographed surfaces (stone, wood,
plaster, cobbles, roof tiles) come from [Poly Haven](https://polyhaven.com),
which is free for any use:

```bash
npm run texture:get -- --search cobble         # find one; the id is also the end of its page address
npm run texture:get -- cobblestone_floor_08    # -> maps/textures/cobblestone_floor_08/
```

Each set is three images: `color.jpg`, `normal.jpg` (fine relief) and
`arm.jpg` (occlusion, roughness and metalness in its red, green and blue),
plus `info.json` saying how much ground one repeat covers. In a Blender
script, `surface("Cobbles", "cobblestone_floor_08")` from
`tools/blender/surfaces.py` makes the material, and `tint=` gives one set
many colours (the town's five plasters are one set). For a surface that
repeats many times in one view (a long wall), add `even=0.8`: it takes the
photograph's own broad light and dark patches out, which are what the eye
catches repeating, and you paint patches back with vertex colours. By hand, in the Shader
Editor:

- `color.jpg` → Base Color. To tint it, put a Mix node set to Multiply
  (factor 1) between them, with your colour in the other input.
- `normal.jpg` (Color Space: Non-Color) → Normal Map node → Normal.
- `arm.jpg` (Non-Color) → Separate Color; Green → Roughness, Blue → Metallic.
  For the occlusion, add a node group named `glTF Material Output` with a
  float input `Occlusion` and connect Red to it.

Lay the UVs so one repeat covers the size in `info.json` and the surface
appears at its true scale. The export shares each image across the whole map
and compresses it; nothing else to do.

**Shape the land.** Terrain is an ordinary mesh: sculpt it, and set
everything else on it. Three things make it read as ground rather than a
green sheet, and the town script (`tools/blender/make_test_town.py`) does all
three:

- A ground texture tinted by painted vertex colours (lush, dry, trodden,
  mud): `surface("Ground", "grass_ground", vertex_colors="Col", tone=...)`.
  `tone` recolours a texture set to any average colour, lighter or darker,
  keeping its detail; a plain `tint` can only darken.
- Roads and paving as their own meshes draped over the terrain (`drape` and
  `ribbon` in the script), so they follow every rise and their texture is
  their own.
- `ground_cover = "grass"` on the terrain, with a `ground_cover` vertex group
  cleared under roads, buildings and water.

Two more things belong to the ground and are set on the terrain object:

- **Worn paths and rock faces.** `blend_layer` names a second material and
  `blend_mask` an image laid over the object from above; where the image is
  white the second material shows, and the edge between the two breaks up
  along the texture's own clumps instead of fading like a gradient. The town
  paints its dirt roads and trails this way (`paint_path` in the script) and
  lowers the ground under them (`wear`), so a path is a groove worn into the
  land, and two paths that cross simply merge. The island blends rock onto
  everything steep, from a mask computed from the slope.
- **`height_map = true`**, which lets water tell how deep it is at every
  point: it thins out toward the bank instead of ending in a hard line.

Every textured map material also gets, automatically, sharp filtering at
shallow angles and broad patches of slightly different light and hue, many
repeats wide, which is what stops a tiled texture from showing its grid
across a long wall or a field. On the widest surfaces add `detile` (see the
material properties above): the same texture is mixed in again at a shifted
position and at a much larger scale, and the large copy takes over with
distance, where repetition is otherwise most obvious.

**Plant trees, bushes and undergrowth.** `tools/blender/plants.py` builds
them, for level scripts:

```python
from plants import broadleaf_tree, conifer_tree, bush, hedge_segment, import_model

oak = broadleaf_tree("oak", seed=3)          # also "ash", "thorn"; conifer_tree("spruce" | "fir")
place(oak.mesh, x, y, collision="cylinder", collision_radius=oak.trunk_radius, far_mesh=oak.far.name)
fern = import_model("fern_02", max_triangles=500)   # a scanned plant from maps/models/
```

A tree is real wood (trunk, limbs, branches) carrying a few hundred cards,
each painted with a whole leafy twig and cut out along the leaves' outline:
about 2,400 triangles, against the millions of a scanned tree. Make a handful
(different kinds and seeds) and place each many times as linked duplicates,
which the game draws in one batch per kind. `far` is its stand-in for the
distance: two or three crossed flat cards showing a picture of that very
tree (rendered once, when the script runs, into an atlas all plants share);
naming it in the object's `far_mesh` property is what distant chunks show.
The cards are merged into each chunk's single far mesh, so a distant wood
costs no extra draw calls. Each plant also carries, in its second UV map, how
much every vertex should sway, and the game's wind moves trunk, branch and
leaf together. `npm run model:get -- <id>` fetches scanned ferns, shrubs and
weeds for the ground; check the triangle count it prints first, and give
anything that small `lod_skip`.

**Add water.** In Blender, make a flat mesh at the water's level and give it
a material named `Water` (or `Sea`); give the object `collision = "none"`.
That is all: the game replaces the material with its own, and the player
swims wherever the water is deep enough to float in. Any outline works, and
the mesh needs no UV map. Tune the look in the debug panel's Water folder or
with the options to `createWater` in `game/scene.ts` (colour, clarity, ripple
size and strength). For water made in code, put `water.material` on the mesh
and call `water.prepareMesh(mesh)`.

**Replace a Blender material with one made in code.** Water does this, and
anything else can: pass `materials: { Name: { material, prepareMesh } }` to
`loadMap`. Everything in the map using a material of that name is drawn with
yours, and the Blender one is never loaded. Turn `backFaceCulling` off on it
(see `MaterialOverride` in `engine/map.ts` for why).

**Give the character a swim animation.** Name the clip in `MODEL.clips.swim`
in `game/player.ts`. Without one (the fox has none) it paddles with a slowed
run cycle. `floatDepth` and `swimSpeed` in the player options set how low it
rides and how fast it goes. Jumping works from the water, which is how you
get out onto a bank or a ledge.

**Add something that moves and blocks the way.** The town's gate
(`portcullis` in `game/interactions.ts`) is the worked example: Blender marks
where it goes and how big it is, code builds it as an animated physics body,
a lever interactable works it, and `blockNavigation(mesh, true)` tells
navigation while it is shut so characters stop routing through it.

**Make a character walk somewhere.** `navigation` is created in
`game/scene.ts` and keeps itself up to date as the map streams:

```ts
const agent = navigation.addAgent(start, { speed: 2 });
agent.goTo(target);                  // false if there's nowhere walkable near the target
agent.position; agent.velocity;      // read these each frame to move and turn your model
navigation.findPath(from, to);       // just the route, without an agent
navigation.randomPointAround(center, 10);
```

Agents steer around each other and stop when the game is paused.
`game/npcs.ts` is a complete example, including keeping feet on the real
ground. "Show walkable area" in the debug panel draws what the agents know.

**React to the player walking somewhere, or using something.** Place the zone
or the usable thing in Blender (see the conventions above) or add it in code,
then say what it does in `game/interactions.ts`:

```ts
triggers.onEnter("ruins_gate", () => hud.toast("The old gate"));
triggers.onExit("ruins_gate", ({ zone }) => { /* ... */ });
triggers.onInteract("campfire", (fire) => {
  effects.setPlaced("campfire", false);   // the Empty carries both `fx` and `interact`
  fire.prompt = "Light the fire";         // or fire.enabled = false to make it unusable
});

// The same things made in code:
triggers.addZone({ name: "checkpoint", position, size: new Vector3(4, 3, 4) });
triggers.addInteractable({ name: "lever", at: leverMesh, prompt: "Pull the lever" });
```

Zones fire for the player by default; pass `{ anyBody: true }` to hear about
any physics body, such as a crate pushed onto a pressure plate. Characters
without a physics body (the demo foxes) don't set zones off. Nothing fires
while paused. "Show triggers" in the debug panel draws them.

**Play a particle effect.** `effects` is created in `game/scene.ts`:

```ts
effects.burst("dust", position);                          // one-shot, cleans itself up
const fire = await effects.spawn("campfire", position);   // runs until fire.stop()
effects.raining = true;                                   // weather follows the camera
```

Built in: `dust` and `sparks` (defined in code in `engine/effects.ts`; copy one
to start your own), `campfire`, `explosion`, and the stock particle files
`fire`, `smoke`, `rain`. The debug panel's Effects folder fires each of them.

**Add your own effect.** Author it in Babylon's particle editor or the
Inspector, save the JSON as `public/assets/particles/systems/<name>.json` with
its textures under `public/assets/particles/textures/`, then
`effects.spawn("<name>", position)`. To place one in a map, add an Empty in
Blender with the custom property `fx = "<name>"`.

Two things to know when authoring:

- Particles are unlit, and this scene is HDR under a bright sun, so colours
  authored for a plain scene look dark. Pass `{ brightness: 2 }` or add an
  entry to `PRESET_TUNING` in `engine/effects.ts`. Colours above 1 glow.
- Lights that belong to effects (firelight, flashes) go in a light cluster, so
  they can appear and disappear without stalling the game. Don't create
  ordinary `PointLight`s at runtime: each one recompiles every material.

The four stock files are Babylon's own presets, kept as placeholders. Delete
them from `public/assets/particles/` (3 MB) once you have your own.

**Tune what the player can walk over.** `stepHeight` in `createPlayer`'s
options is the tallest ledge climbed without jumping (0.18 m by default, sized
for the fox; about a quarter of the character's height looks natural). Build
stairs with risers under that; taller ledges need a jump.

**Change the time of day.** `lighting.setSunDirection(new Vector3(x, y, z))`, or
drag the sun sliders in the debug panel.

## Scripts

| | |
|---|---|
| `npm run dev` | dev server with hot reload |
| `npm run typecheck` | TypeScript check, no output |
| `npm run build` | typecheck + production build into `dist/` |
| `npm run preview` | serve the production build locally |
| `npm run map:export -- <file.blend>` | export a Blender map into `public/maps/` |
| `npm run map:make-town` | regenerate and export the test town |
| `npm run map:make-hall` | regenerate and export the inside of the town's hall (an interior: see "Add an interior") |
| `npm run texture:get -- <id>` | fetch a surface texture set from Poly Haven into `maps/textures/` (`-- --search <word>` to find ids) |
| `npm run model:get -- <id>` | fetch a scanned model (shrub, fern, rock) from Poly Haven into `maps/models/` (`-- --search <word>` lists ids with triangle counts) |
| `npm run map:make-test` | regenerate and export the test island |

## Guides

- [docs/lessons.md](docs/lessons.md): what building this scaffold taught:
  what makes a scene look real, Babylon and Blender traps, extending the
  standard material, asset choices, performance, and how to test in the
  browser. Read it before starting a game on this.
- [docs/level-building.md](docs/level-building.md): how a level is put
  together, from the ground up, and what keeps it fast.
- [docs/hair-and-fur.md](docs/hair-and-fur.md): how to do hair, fur and fuzzy
  surfaces (not implemented yet; this is the plan to follow).

## Not included

These depend on the game, so the scaffold leaves them to you: an
entity/component framework, AI behaviour beyond walking (the foxes only wander
and follow), networking and save data. Map textures are compressed by the map
export; for standalone models, compress with `gltf-transform` (Meshopt or
Draco geometry, KTX2 textures) before shipping.

## Notes

- Vite is pinned to v6 because v7+ needs Node 20.19+ or 22.12+.
- Babylon classes are imported from their own modules
  (`@babylonjs/core/Meshes/mesh`, not `@babylonjs/core`), which keeps the
  production script to about 3.5 MB (0.87 MB gzipped) instead of 8.5 MB. Types
  may still come from the package root with `import type`. Features Babylon
  reaches indirectly are switched on in `engine/babylonFeatures.ts`; if a new
  feature fails at runtime with a missing method or "is not a constructor",
  its module belongs there.
- Menus are mouse/touch only for now; there is no gamepad navigation of them.
- Anti-aliasing depends on the preset. "High" and "ultra" use temporal
  anti-aliasing (TAA): each frame is blended with the previous ones, following
  per-pixel motion so moving things don't smear, then lightly sharpened. Those
  presets aren't multisampled, because the buffers SSAO and TAA read can't be.
  "Low" and "medium" use the preset's MSAA plus FXAA. The classic renderer has
  no TAA and falls back to FXAA.
- On WebGPU the engine asks for the GPU's real limits and optional features
  at startup. The lit material with four shadow cascades and motion vectors
  needs 17 values passed between shader stages, one more than WebGPU's default
  allowance, and compressed textures are an optional feature: without it they
  are unpacked to full size.
- Grass doesn't cast shadows, and it thins out to nothing at its drawing
  distance (40 m; the nearest 15 m are planted more thickly). Its density
  follows the quality preset (`groundCover`; off on "low"). Wind moves the
  plants but not their shadows.
- Frame time on WebGPU is the CPU's, and follows the number of separate
  things drawn, not triangles: the GPU sits mostly idle. The test town is
  about 800 draws and 10 ms a frame on the "high" preset (measured on an
  Apple-silicon laptop at 1018 x 981); the island about 9 ms. What got it
  there is in [docs/lessons.md](docs/lessons.md) under Performance: static
  batches for everything repeated, and shadow cascades that skip what cannot
  reach them.
- Repeated map objects are static batches, so one copy cannot be moved,
  hidden or picked on its own. Anything that needs that is built in code at a
  marker, as the town's gate is.
- Water is Babylon's standard PBR material, not the `WaterMaterial` from its
  materials library. That one draws the scene two more times per frame for
  its reflection and refraction, through render targets that only the classic
  pipeline runs (under the Frame Graph they never update), and it isn't
  physically based, so it doesn't match an HDR scene. What ours gives up is
  mirroring nearby objects: it reflects the sky and sun only. Surfaces are
  flat and level; the waves are painted on, and the swimmer's bob is
  animation. The soft shoreline needs the map to carry a height image
  (`height_map` on the terrain); without one the water's edge is a hard
  line. The demo foxes neither swim nor avoid water.
- Navigation is worked out on the main thread, a few milliseconds per frame
  while the surroundings change and nothing once they settle. Babylon's
  add-on has a worker mode but it is switched off in 9.36. The walkable area
  loaded at once is limited to 4,096 tiles of 6 m (a 384 m square's worth; only
  full-detail chunks count), dynamic props
  (crates, balls) are not obstacles, and stair treads must be at least 25 cm
  deep to count as walkable.
- `@recast-navigation/*` is pinned to 0.44.0: 0.43.0, the version Babylon's
  add-on loads by default, leaks memory each time the walkable area is
  rebuilt.
- Bloom works on true HDR values: its threshold sits just above sunlit white,
  so only fire, sparks, emissive surfaces and the sun glow. Emissive materials
  need an intensity well above 1 to bloom.
- In dev builds the running game is on `window.game` (`game.scene`,
  `game.player`, `game.map`, `game.navigation`, `game.triggers`, `game.lighting`,
  `game.renderer`).
- Simulated time per frame is capped at 1/30 s, so after a hitch the game
  briefly runs slow rather than physics taking one huge step.

## Credits

`public/assets/particles/` holds particle presets and textures from the
[Babylon.js Assets](https://github.com/BabylonJS/Assets) repository (CC-BY 4.0).

`public/assets/models/Fox.glb` is the Khronos glTF sample "Fox": model by
PixelMannen (CC0), rigging and animation by @tomkranis (CC-BY 4.0), glTF
conversion by @AsoboStudio and @scurest (CC-BY 4.0).

`maps/textures/` and `maps/models/` hold surface textures and scanned plants
from [Poly Haven](https://polyhaven.com) (CC0; each one's `info.json` names
its source page and authors).

`public/babylon/ktx2/` holds the Basis Universal texture transcoders shipped
with `@babylonjs/ktx2decoder` (Apache-2.0; licence in that folder).
