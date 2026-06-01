package gameserver

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/sim"
)

// Demo unit stats. These exact float values are mirrored by the browser demo
// page (wasm-demo.html), which passes the same numbers through the wasm
// bridge's FromFloat boundary. Because the server and every predicting client
// derive the fixed-point meta from identical floats, a Spawn order resolves to
// a bit-identical unit everywhere — which is what keeps the lockstep hashes
// agreeing across windows.
const (
	demoMaxVelocity = 1.6  // world units / frame (30 Hz locomotion)
	demoTurnRate    = 1000 // TA-angle / frame
	demoAccel       = 0.12 // world units / frame^2
	demoBrakeRate   = 0.25 // world units / frame^2
)

// DemoSpawnFunc returns a spawn provider that needs no game assets: it resolves
// the single synthetic unit type "scout" used by the standalone browser demo.
// `kbot host` falls back to this when no --root is given, so the multiplayer
// path can be exercised end-to-end without a TA install.
func DemoSpawnFunc() sim.SpawnFunc {
	return func(name string) (*sim.UnitMeta, sim.Binding) {
		if name != "scout" {
			return nil, nil
		}
		return &sim.UnitMeta{
			Name:        "scout",
			CanMove:     true,
			MaxVelocity: fixed.FromFloat(demoMaxVelocity),
			TurnRate:    fixed.FromFloat(demoTurnRate),
			Accel:       fixed.FromFloat(demoAccel),
			BrakeRate:   fixed.FromFloat(demoBrakeRate),
		}, nil
	}
}
