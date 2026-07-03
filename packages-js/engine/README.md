# KBot engine

The deterministic KBot simulation engine — the Go sim core from
[coreprime/kbot](https://github.com/coreprime/kbot) compiled to WebAssembly —
packaged with a small ESM loader for browsers and Node.

The engine owns game state, orders, movement, combat and the COB script VM.
It emits per-tick render snapshots (unit poses + packed piece transforms +
events) that a renderer such as the KBot Studio sandbox draws. It performs no
I/O and no rendering itself, which is what makes it deterministic: the same
seed plus the same order stream produces the same world hash everywhere.

## Install

This package is published publicly on npmjs.org, so no registry or auth
configuration is needed to consume it:

```
npm install @kbot/engine
```

(Publishing needs a token — CI authenticates with
`//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`, sourced from the
environment; never commit a literal token.)

## Use

```js
import { loadEngine } from '@kbot/engine'

const engine = await loadEngine() // bundled engine.wasm; pass { wasmUrl } to override
const session = engine.createSession({ seed: 42 })

const id = session.addUnit({ name: 'probe', canMove: true, maxVelocity: 1.5, acceleration: 0.5, brakeRate: 1, turnRate: 800 }, 100, 100)
session.submitMove([id], 100, 400)
const snapshot = session.step() // one tick; snapshot.units[].x/y/z etc.
```

`loadEngine()` is a singleton per JS realm (the wasm module registers one
global API); run multiple simulations by creating multiple sessions. In Node
the parked wasm runtime keeps the event loop alive — exit explicitly when done.

## Building from source

The wasm binary is generated from the repo's Go code and is not committed:

1. `npm run build` (in `packages-js/engine/`) compiles `cmd/engine-wasm` with
   `GOOS=js GOARCH=wasm` into `wasm/engine.wasm` and copies the matching
   `wasm_exec.js` from the local Go toolchain — a Go toolchain is required.
2. `npm pack` / `npm publish` run the build automatically via `prepack`.

The studio's own copy is built separately by `task build-wasm` at the repo
root; the two are the same Go program.
