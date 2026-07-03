# KBot game3d

A self-contained WebGL renderer for Total Annihilation-style scenes from
[coreprime/kbot](https://github.com/coreprime/kbot): 3DO model geometry, GAF
textures, palette-resolved flat shading, COB-posed piece trees, terrain / sky /
water environments, shadows, LOD, particles and weapon effects. No three.js,
no host server.

game3d is the **view only** — it draws whatever unit/projectile state it is
given and knows no game rules. Simulation (movement, combat, the COB script
VM) belongs to a driver such as [`@kbot/engine`](https://www.npmjs.com/package/@kbot/engine),
whose per-tick snapshots map straight onto `applyState()`. All asset I/O goes
through one injected **AssetProvider** — the renderer itself never fetches.

## Install

This package is published publicly on npmjs.org, so no registry or auth
configuration is needed to consume it:

```
npm install @kbot/game3d
```

(Publishing needs a token — CI authenticates with
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, sourced from the
environment; never commit a literal token.)

## Use

```js
import { createWorld } from '@kbot/game3d'

const world = await createWorld(canvas, { assets: myProvider })
const id = await world.addUnit('armpw', { x: 0, z: 0 })
world.step(16)                          // render one frame (or autoStart: true)
world.moveUnit(id, { x: 40, heading: Math.PI / 2 })
world.applyState(engineSnapshot)        // full per-tick state from a sim
world.fireWeapon({ from: [0, 20, 0], to: [200, 0, 200] })
world.dispose()
```

`createWorld` also exposes the underlying stack (`renderer`, `camera`,
`loader`, `palette`, `textureCache`) for deep-integration hosts; every class
is importable individually (`@kbot/game3d/model-renderer`, …) and shares
module state with the root entry.

## Game conventions (headings + COB pieces)

`cob-pose.js` (exported from the root) is the single source of truth for the
game's pose conventions, matched against the original engine:

- **World axes**: +X east, +Y up, +Z south — a map renders the same way as
  its minimap.
- **Heading**: uint16 TA angle, 65536 per turn. Heading 0 faces **−Z
  (north)**; a unit at heading `h` moves along `(-sin, -cos)` of
  `h·2π/65536`, and the compass walks north → west → south → east. Feed raw
  wire/recording headings through `headingToRadians(h)` — no offsets, no
  sign fix-ups — into `transform.headingRad` / `applyState`'s `heading`.
- **COB piece transforms**: axis 0 = x (pitch, positive = nose down),
  1 = y (yaw, positive turns with increasing heading), 2 = z (roll). Convert
  engine piece state with `enginePieceToPose` / `unpackEnginePieces`, and
  apply it **by name** through the unit's COB piece table with
  `applyPackedPieces` — COB table order is not the model hierarchy order
  (a Samson lists its launcher flares before its body).

Maps: `loadMapTerrain(provider, name)` composites a packed map's tile atlas
into the full ground texture and returns the arguments
`renderer.setMapTerrain()` (or `world.setTerrain()`) takes, plus sea level,
start positions and the authentic minimap URL.

**Map features**: `world.setTerrain(terrain)` also installs the map's
features (toggle with `setFeaturesEnabled(on)`, or pass
`{ features: false }`).  GAF-sprite features (trees, rocks, metal, kelp,
props…) become deterministic low-poly 3D stand-ins built per CATEGORY —
shapes that read correctly from TA's classic angle and survive orbiting —
sized from the pack's `features.json` (format v5) footprint/height/sprite
dims and seeded per (name, cell) so every run bakes identical geometry.
Features with real 3DO models (wrecks, dragon teeth) place the actual
packed model.  The whole field bakes into a handful of static batches —
one draw call each, no per-feature frame cost (`buildFeatureField` is
exported for standalone use).

## Replay presentation

Everything a state-driven consumer (a replay renderer) needs to make a
world read like the game, all presentation-only — no sim state, no hashes:

- **Weapon effects** — `world.weaponEffect({ weapon: '<id>', from, to })`
  resolves the id against the pack's `weapons.json` and draws the weapon's
  authentic visual: palette-tinted laser pulse beams, the D-gun fireball
  with its flame trail and scene-washing light, the packed projectile 3DO
  flying a TRUE trajectory — ballistic arcs solved to land on the target,
  guided missiles steering at the TDF `turnrate` and detonating on
  proximity, torpedoes holding depth under the sea sheet with bubble
  trails (format v5 fields) — fx.gaf bitmap bolts, or AoE-scaled particle
  tracers, plus muzzle flash, start-smoke and the impact.  Impacts route
  through the polygonal explosion system (below); at/below the waterline
  they splash (spray + bubbles + foam ring) instead of burning.  Explicit
  `color`/`durationMs`/`velocity` override the def; `type:
  'beam'|'tracer'` without a weapon keeps the raw line-effect path.
- **Explosions** — every impact/death detonates a polygonal 3D explosion
  (expanding emissive fireball polyhedron + spinning shards + ground
  shockwave ring, additive so the cinematic bloom lifts it) sized by a
  small/medium/large/huge ladder off `areaOfEffect` + death severity.
  Readability is enforced: per-hit effects are brief and tight, spawns
  coalesce per area bucket instead of stacking, a global concurrency cap
  recycles records, and sqrt-law luminance budgets dim both the additive
  particles and the dynamic lights as a barrage grows — the field stays
  readable under any bombardment (see `explosion-fx.js` +
  `performance.js` for the tunables and rationale).
- **Death** — `world.unitDeath(id, { severity, corpse, heapCorpse,
  impactDir, impactMag })` follows TA's corpsetype ladder: a clean kill
  (severity < 50) swaps in the wreck 3DO (pack unitdb
  `meta.corpseObject`), sunk slightly and persistent until
  `removeCorpse(id)`/`clearCorpses()`; heavier kills throw the unit's
  pieces as tumbling debris — parabolic world-space arcs that spin,
  bounce off the terrain with energy loss and settle before fading, with
  `impactDir` ([x,z], source → victim) biasing the scatter away from the
  killing blow.  Airborne units (`air: true`) instead enter a spiral
  crash: a spinning, smoking descent that detonates where it meets the
  terrain or splashes into the sea.  The applyState form: a live unit
  re-sent with `dead: true` (+ `deathSeverity`/`corpse`/`heapCorpse`/
  `impactDir`/`impactMag`) triggers the same path once.
- **Air / sea flags** — applyState `air: true` adds a hover bob,
  bank-into-turns and contrails at speed (and the spiral-crash death);
  `hover: true` the hovercraft cushion gyration; `naval: true` a stern
  foam wake while the vessel is under way on the sea sheet.  Units
  crossing the waterline splash.
- **Economy visuals** — `world.latheBeam(key, { fromUnitId, toUnitId })`
  streams the green nano spray onto a build target while its
  `buildPercent` drives the rising wireframe→solid hull (the lathe line
  glows at the cut); `world.reclaimBeam(key, { fromUnitId, corpseId })`
  reverses the stream and shrinks the wreck while beamed;
  `world.captureFlash(id)` plays the capture pulse.  Building activity
  (extractor rotors, solar collectors) is driven through the ENGINE —
  `Session.setUnitActivation(unitId, on)` runs the unit's real COB
  Activate/Deactivate entry points.
- **Grounding + slope tilt** — applyState/addUnit `grounded: true` clamps a
  unit's render Y to the battlefield surface (`world.terrainHeightAt`) and
  pitches/rolls it to the terrain normal.  Recorded wire Y is TA world
  units where the surface sits at rawHeight × 1.0; the renderer draws
  terrain flattened by `heightScale` (0.61), so un-clamped Y must be scaled
  by the same factor — `grounded` sidesteps the conversion entirely.
- **Hit rock** — `world.unitImpulse(id, { dirX, dirZ, mag })` shudders the
  unit on a damped spring (call it on damage events).
- **Status** — per-unit `hp01` (0..1) draws a green→red health bar under
  the unit while damaged and drives TA-style damage smoke; `rank` (0..5)
  draws gold veteran chevrons.  Both render in the scene pass —
  depth-tested against the world, so a unit behind a ridge shows no bar —
  and headless captures include them.
- **COB smoke** — forward engine render events through
  `applyState({ events })` / `world.sfxEvent(ev)`: `emitSfx` plumes
  (SmokeUnit threads) and `explode` flashes render at their anchors.
- **Smooth frames** — `lerpPackedPieces(prev, next, alpha)` blends engine
  piece buffers with shortest-arc rotations; applyState renders
  externally-lerped positions/headings as-is.
- **Quality** — `createWorld({ quality: 'cinematic' })` (or
  `world.setQuality`) adds bloom, the ACES grade and FXAA over the
  always-on specular/metal hints, blinking running lights, god beams and
  dynamic weapon lights.  Explicitly-stepped worlds drive the renderer's
  effect clock from `step(dtMs)`, keeping every animated effect a pure
  function of the fed timeline.
- **Team colours** — `TA_TEAM_SIDES` (exported) is the default side →
  colour table; pass a unit `side` (0..7) through applyState and the
  hue-shift recolour applies.

## The AssetProvider seam

Implement this interface against any asset backend and pass it as
`{ assets }` (or call `setAssetProvider()` directly). Required methods:

```ts
palette(): Promise<[r, g, b][]>                      // 256-entry palette
model(name, { enhanceMesh? }): Promise<ModelGeometry> // preprocessed 3DO tree
texture(name): Promise<Blob | ImageBitmap | HTMLImageElement>
```

Optional (the renderer degrades gracefully without them): `script` (COB),
`groundTile`, `sound` / `soundUrl`, `cursor` / `cursorUrl`, `weaponBitmap`,
and — for drivers built on top of the renderer — `manifest`, `unitDB`, `map`.
See `index.d.ts` for the full contract.

Implementations:

- **StudioAssetProvider** — ships with the KBot Studio web client and wraps
  the studio server's asset API; the studio sandbox runs on it.
- **HttpPackProvider** — exported from this package: serves a static
  pre-extracted asset pack (`kbot pack` output) from a plain HTTP base URL;
  no server logic needed.

  ```js
  import { createWorld, HttpPackProvider } from '@kbot/game3d'
  const world = await createWorld(canvas, {
    assets: new HttpPackProvider('https://cdn.example.com/packs/ta-31c'),
  })
  ```
- **HpiProvider** *(planned)* — reads original HPI/UFO archives directly in
  the browser.

## Building from source

`npm run build` (in `packages-js/game3d/`) embeds the GLSL under `shaders/**`
and the world JSON under `worlds/` into generated modules, then emits the
module-per-file ESM tree under `dist/` that the package publishes.
`npm pack` / `npm publish` run it automatically via `prepack`.
