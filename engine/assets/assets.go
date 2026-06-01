// Package assets defines the boundary through which the otherwise-pure
// simulation obtains unit definitions and scripts. The native server build
// backs this with the virtual filesystem; the wasm build backs it with HTTP
// fetches against the studio asset endpoints (or a bundled pack). Keeping the
// interface here lets engine/sim and engine/session stay free of any I/O.
package assets

import "github.com/coreprime/kbot/engine/sim"

// Provider resolves a unit type name into its simulation metadata and an
// optional script binding. Implementations live outside the engine core so
// the core never imports os, net or a filesystem.
type Provider interface {
	// Unit returns the stat block and (optional) COB script binding for a unit
	// type, or ok=false if the type is unknown.
	Unit(name string) (meta *sim.UnitMeta, binding sim.Binding, ok bool)
}

// SpawnFunc adapts a Provider into the sim.SpawnFunc the world calls when a
// Spawn order arrives.
func SpawnFunc(p Provider) sim.SpawnFunc {
	return func(name string) (*sim.UnitMeta, sim.Binding) {
		meta, binding, ok := p.Unit(name)
		if !ok {
			return nil, nil
		}
		return meta, binding
	}
}
