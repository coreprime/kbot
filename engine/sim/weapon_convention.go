package sim

// Weapon-script conventions.
//
// A unit's COB exposes its weapon entry points in one of two shapes:
//
//   - Per-slot (Total Annihilation): Aim/Fire/Query<Primary|Secondary|
//     Tertiary> triples, one per weapon slot. An aim thread signals
//     completion by returning TRUE.
//   - Shared (TA: Kingdoms): one parameterized AimWeapon/FireWeapon/
//     QueryWeapon set for every slot, taking the weapon index as an
//     argument. Aim completion is signalled out-of-band — the script writes
//     the weapon index into the WEAPON_READY port (or WEAPON_AIM_ABORTED on
//     give-up) instead of returning a value, and the engine owns pivoting a
//     mobile unit's body toward the target.
//
// The convention is resolved per unit from what the COB itself exports —
// deterministic and dependency-free, so the sim never consults a game id and
// a TA-convention COB inside a TA:K install (or a custom game mixing both)
// just works.

// weaponConvention is the strategy for one COB weapon-script shape. Both
// implementations are stateless singletons; conventionFor picks per binding.
type weaponConvention interface {
	// aimScript / fireScript / queryScript name the slot's entry points
	// ("" when the slot has no name under this convention).
	aimScript(slot int) string
	fireScript(slot int) string
	queryScript(slot int) string
	// aimArgs is the stack for starting/restarting an aim thread.
	aimArgs(heading, pitch int32, slot int) []int
	// fireArgs is the stack for the fire thread (nil = no arguments).
	fireArgs(slot int) []int
	// queryArgs is the stack for the query script; the first element is the
	// out-local the script writes the muzzle piece into.
	queryArgs(slot int) []int
	// bodyAim reports whether the engine, not the unit's script, owns
	// turning the unit to face its weapon target.
	bodyAim(m *UnitMeta) bool
	// pollAimReady consumes the convention's aim-completion signal and
	// updates the slot's aimReady gate in place. simMs re-stamps
	// s.aimStartMs when an abort re-arms the gate.
	pollAimReady(b Binding, ab aimBinding, s *weaponSlot, slot int, simMs int64)
}

// conventionFor resolves the weapon convention a binding's COB follows.
// Exporting the shared AimWeapon entry point is the discriminator — every
// retail TA:K COB ships it, no TA COB does.
func conventionFor(b Binding) weaponConvention {
	if b != nil && b.HasScript("AimWeapon") {
		return takConvention{}
	}
	return taConvention{}
}

// weaponSlotSuffix maps a weapon slot to the COB naming convention TA uses
// for its per-weapon aim/fire/query entry points.
var weaponSlotSuffix = [3]string{"Primary", "Secondary", "Tertiary"}

// taConvention — per-slot scripts, thread-return aim completion.
type taConvention struct{}

func taSlotScript(prefix string, slot int) string {
	if slot < 0 || slot >= len(weaponSlotSuffix) {
		return ""
	}
	return prefix + weaponSlotSuffix[slot]
}

func (taConvention) aimScript(slot int) string   { return taSlotScript("Aim", slot) }
func (taConvention) fireScript(slot int) string  { return taSlotScript("Fire", slot) }
func (taConvention) queryScript(slot int) string { return taSlotScript("Query", slot) }

func (taConvention) aimArgs(heading, pitch int32, _ int) []int {
	return []int{int(heading), int(pitch)}
}
func (taConvention) fireArgs(int) []int { return nil }

// queryArgs: TA's Query<slot> takes one local — the piece, written by the
// script.
func (taConvention) queryArgs(int) []int { return []int{0} }

// bodyAim: TA units aim via their COB (AimPrimary turns the turret pieces);
// the engine never pivots the body for them.
func (taConvention) bodyAim(*UnitMeta) bool { return false }

// pollAimReady: a TA aim thread reports completion by returning TRUE.
func (taConvention) pollAimReady(_ Binding, ab aimBinding, s *weaponSlot, _ int, _ int64) {
	if s.aimReady {
		return
	}
	if done, ret := ab.AimStatus(s.aimThread); done && ret == 1 {
		s.aimReady = true
	}
}

// takConvention — shared parameterized scripts, port-handshake aim
// completion.
type takConvention struct{}

func (takConvention) aimScript(int) string   { return "AimWeapon" }
func (takConvention) fireScript(int) string  { return "FireWeapon" }
func (takConvention) queryScript(int) string { return "QueryWeapon" }

// aimArgs: the shared AimWeapon receives the weapon index after the bearing;
// the script echoes it back through WEAPON_READY.
func (takConvention) aimArgs(heading, pitch int32, slot int) []int {
	return []int{int(heading), int(pitch), slot}
}

// fireArgs: the shared FireWeapon dispatches on the weapon index.
func (takConvention) fireArgs(slot int) []int { return []int{slot} }

// queryArgs: the shared QueryWeapon takes (piece-out, weaponIdx) so the
// script can branch per weapon; the piece still comes back through the first
// local.
func (takConvention) queryArgs(slot int) []int { return []int{0, slot} }

// bodyAim: TA:K's shared AimWeapon scripts manage recoil/readiness but
// expect the engine to rotate a mobile unit's body. Aircraft keep their
// fire-arc maneuvering instead.
func (takConvention) bodyAim(m *UnitMeta) bool {
	return m != nil && m.CanMove && !m.IsAircraft
}

// takAimBinding is the optional surface a script binding exposes so the
// weapon SM can consume TA:K's port-based aim handshake. The script VM's
// *Unit satisfies it; for bindings without it the SM falls back to the
// stuck-timeout.
type takAimBinding interface {
	TakeWeaponReady(slot int) bool
	TakeWeaponAimAborted(slot int) bool
}

// pollAimReady: the script writes the weapon index into WEAPON_READY when
// its aim solution holds and into WEAPON_AIM_ABORTED when it gives up. An
// abort re-arms the gate even on a settled aim.
func (takConvention) pollAimReady(b Binding, _ aimBinding, s *weaponSlot, slot int, simMs int64) {
	tb, ok := b.(takAimBinding)
	if !ok {
		return
	}
	if tb.TakeWeaponAimAborted(slot) {
		s.aimReady = false
		s.aimStartMs = simMs
	}
	if !s.aimReady && tb.TakeWeaponReady(slot) {
		s.aimReady = true
	}
}
