# KBot game3d

A self-contained WebGL renderer for Total Annihilation-style scenes from
[coreprime/kbot](https://github.com/coreprime/kbot): 3DO model geometry, GAF
textures, palette-resolved flat shading, COB-posed piece trees, terrain / sky /
water environments, shadows, LOD, particles and weapon effects. No three.js,
no host server.

game3d is the **view only** — it draws whatever unit/projectile state it is
given and knows no game rules. Simulation (movement, combat, the COB script
VM) belongs to a driver such as [`@coreprime/kbot-engine`](https://www.npmjs.com/package/@coreprime/kbot-engine),
whose per-tick snapshots map straight onto `applyState()`. All asset I/O goes
through one injected **AssetProvider** — the renderer itself never fetches.

## Install

This package is published publicly on npmjs.org, so no registry or auth
configuration is needed to consume it:

```
npm install @coreprime/kbot-game3d
```

(Publishing needs a token — CI authenticates with
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, sourced from the
environment; never commit a literal token.)

## Use

```js
import { createWorld } from '@coreprime/kbot-game3d'

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
is importable individually (`@coreprime/kbot-game3d/model-renderer`, …) and shares
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
start positions and the authentic minimap URL.  Beyond the map rect the
world renders an infinite dark Tron-style void grid (glowing lines, depth
fade; `renderer.voidGridEnabled = false` to disable) instead of the light
sky backdrop; the studio's flat-pad scenes are unaffected.

**Map features**: `world.setTerrain(terrain)` also installs the map's
features (toggle with `setFeaturesEnabled(on)`, or pass
`{ features: false }`).  GAF-sprite features (trees, rocks, kelp,
props…) become deterministic low-poly 3D stand-ins built per CATEGORY —
shapes that read correctly from TA's classic angle and survive orbiting —
sized from the pack's `features.json` (format v5) footprint/height/sprite
dims and seeded per (name, cell) so every run bakes identical geometry.
Ground-set categories render as FLAT terrain-conforming decals instead:
metal deposits as dark paneled plates, geothermal steam vents as a
scorched vent mouth that puffs a live fx-clock-driven steam wisp.
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
  'beam'|'tracer'` without a weapon keeps the raw line-effect path.  Every
  shot is LINE-OF-SIGHT checked against the terrain (`terrain-los.js`): a
  beam/tracer/projectile fired at a unit behind a ridge terminates ON the
  slope with a dirt-puff impact instead of reaching the (undamaged) target
  — so a blocked shot visibly splashes on the hillside.
- **Explosions** — every impact/death detonates a polygonal 3D explosion
  (expanding emissive fireball polyhedron + spinning shards + ground
  shockwave ring, additive so the cinematic bloom lifts it) sized by a
  small/medium/large/huge/mushroom ladder off `areaOfEffect` + death
  severity.  The mushroom tier (commander-class deaths) is a distinct big
  shape — ground flash → fast tapered rising STEM → large billowing CAP
  that overhangs the stem and rolls under — plus a CONCUSSIVE blast: a
  ground-hugging pressure ring racing outward along the terrain and a brief
  camera-agnostic pressure-ripple bubble.  Everything scales off the
  death-weapon AoE.
  Readability is enforced: per-hit effects are brief and tight, spawns
  coalesce per area bucket instead of stacking, a global concurrency cap
  recycles records, and sqrt-law luminance budgets dim both the additive
  particles and the dynamic lights as a barrage grows — the field stays
  readable under any bombardment (see `explosion-fx.js` +
  `performance.js` for the tunables and rationale).
- **Death** — `world.unitDeath(id, { severity, corpse, heapCorpse,
  impactDir, impactMag, deathAoe })` follows TA's corpsetype ladder: a
  clean kill (severity < 50) swaps in the wreck 3DO (pack unitdb
  `meta.corpseObject`), sunk slightly and persistent until
  `removeCorpse(id)`/`clearCorpses()`; heavier kills throw the unit's
  actual MODEL PIECES as tumbling debris CHUNKS — the model breaks along
  its own COB piece tree (turret / hull / barrel / legs), a moderate
  piece-driven count (~4-16, not a shard cloud), with a one-piece unit's
  largest part split so it still sheds several chunks.  Chunks fly clean
  OUTWARD parabolas that tumble in place, bounce off the terrain with
  energy loss and settle before fading, with `impactDir` ([x,z], source →
  victim) biasing the scatter away from the killing blow.  A moving unit
  also passes its VELOCITY at death into the burst (momentum): the chunks
  are thrown along its travel direction on top of the radial spray.  The
  world measures that velocity from the unit's own position history, or a
  driver passes it explicitly (`velocity: [vx,vy,vz]` WU/s, both on
  `unitDeath` and the applyState `su.velocity` field).  The death
  detonation is SIZED from the unit's FBI death-explosion weapon: pass
  `deathAoe` (blast diameter in WU, from the pack unitdb
  `meta.explodeWeapon.areaOfEffectWU`, or `meta.selfDestructWeapon`'s for a
  manual self-destruct) and the explosion tier ladder scales with it — a
  peewee (AoE 30) pops small while a commander (`COMMANDER_BLAST` AoE 950)
  renders the full MUSHROOM CLOUD + concussive shockwave, all under the
  same luminance budget.  Omit `deathAoe` and the blast is estimated from
  the model radius (a uniform-ish pop).  Airborne units (`air: true`) get
  the SAME treatment — they EXPLODE IN PLACE + arc-scatter debris under
  gravity (no spiral crash), leaving a brief smoke puff if high.  The
  applyState form: a live unit re-sent with `dead: true` (+
  `deathSeverity`/`corpse`/`heapCorpse`/`impactDir`/`impactMag`/`deathAoe`/
  `velocity`) triggers the same path once.
- **Air / sea flags** — applyState `air: true` adds a hover bob,
  bank-into-turns and contrails at speed (and the explode-in-place death);
  `hover: true` the hovercraft cushion gyration — a gentle lean computed
  about WORLD axes, so the tilt direction holds steady while the craft
  yaws; `naval: true` a stern
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
- **COB emitter anchors** — wire the engine in once with
  `world.setScriptPieceQuery((id, fn) => session.queryScriptPiece(id, fn))`
  and effects originate from the piece the unit's own script names instead
  of the hull centre: `weaponEffect({ fromUnit: { id, weaponSlot }, to,
  weapon })` fires from the COB `Query<Primary|Secondary|Tertiary>` muzzle
  (per-barrel cycling included), `latheBeam`/`reclaimBeam` `fromUnitId`
  sprays from the `QueryNanoPiece` nozzle, and
  `world.unitPieceWorldPos(id, pieceNameOrIndex)` answers any piece's live
  world position through the full transform chain (position, heading /
  pitch / roll, current COB pose).  Everything degrades gracefully to the
  unit-origin anchor when the resolver, script or piece is missing.
- **Factory builds** — factories OPEN while building and the nascent unit
  rides the build pad:
  1. build start — `session.setUnitActivation(factoryId, true)` (COB
     Activate: doors open, arms deploy) and
     `session.startScript(factoryId, 'StartBuilding')` (the pad spins);
  2. while `buildPercent < 100` — place the nascent unit at
     `world.unitPieceWorldPos(factoryId,
     session.queryScriptPiece(factoryId, 'QueryBuildInfo'))` (the pad
     piece), feeding its rising `buildPercent` through applyState;
  3. completion — `session.startScript(factoryId, 'StopBuilding')` then
     `session.setUnitActivation(factoryId, false)` (COB Deactivate closes
     the factory).
- **Grounding + slope tilt** — applyState/addUnit `grounded: true` clamps a
  unit's render Y to the battlefield surface (`world.terrainHeightAt`) and
  pitches/rolls it to the terrain normal.  Recorded wire Y is TA world
  units where the surface sits at rawHeight × 1.0; the renderer draws
  terrain flattened by `heightScale` (0.61), so un-clamped Y must be scaled
  by the same factor — `grounded` sidesteps the conversion entirely.
- **Hit rock** — `world.unitImpulse(id, { dirX, dirZ, mag })` shudders the
  unit on a damped spring (call it on damage events).  Structures stay
  planted: pass `mobile: false` on the unit (addUnit/applyState) — or rely
  on the built-in inference, which treats a grounded unit that has never
  moved or yawed as a building.
- **Status** — per-unit `hp01` (0..1) draws a green→red health bar under
  the unit while damaged and drives TA-style damage smoke; `rank` (0..5)
  draws a row of gold veteran stars beneath the bar — only while the bar
  itself shows, so a full-health unit carries no rank chrome.  Both
  render in the scene pass —
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
  import { createWorld, HttpPackProvider } from '@coreprime/kbot-game3d'
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
