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

Weapon visuals: `world.weaponEffect({ type, from, to, color, durationMs })`
draws presentation-only beams (`'beam'`/`'laser'`) and ballistic tracers
(`'tracer'`) in the scene pass; pass `weapon: '<id>'` to resolve type, color
and timing from the pack's `weapons.json` (`AssetProvider.weaponDefs()`).

Maps: `loadMapTerrain(provider, name)` composites a packed map's tile atlas
into the full ground texture and returns the arguments
`renderer.setMapTerrain()` takes, plus sea level, start positions and the
authentic minimap URL.

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
