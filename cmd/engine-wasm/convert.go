//go:build js && wasm

package main

import (
	"strconv"
	"syscall/js"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/sim"
)

// metaFromJS converts a plain JS unit-meta object (the shape the studio's
// /api/studio/unit endpoint already returns) into the simulation stat block.
// Float values are converted to fixed-point here, at the asset boundary, so the
// tick loop only ever sees integers.
func metaFromJS(o js.Value) *sim.UnitMeta {
	m := &sim.UnitMeta{
		Name:        getString(o, "name"),
		MaxVelocity: fixed.FromFloat(getFloat(o, "maxVelocity")),
		TurnRate:    fixed.FromFloat(getFloat(o, "turnRate")),
		Accel:       fixed.FromFloat(getFloat(o, "acceleration")),
		BrakeRate:   fixed.FromFloat(getFloat(o, "brakeRate")),
		CanMove:     getBool(o, "canMove"),
		IsAircraft:  getBool(o, "isAircraft"),
		IsHover:     getBool(o, "isHover"),
		IsShip:      getBool(o, "isShip"),
		IsSub:       getBool(o, "isSub"),
		IsBuilder:   getBool(o, "isBuilder"),
		OnOffable:   getBool(o, "onoffable"),
	}
	m.CruiseAltitude = fixed.FromFloat(getFloat(o, "cruiseAltitude"))
	if w := o.Get("weapons"); w.Type() == js.TypeObject && !w.IsNull() {
		n := w.Length()
		for i := 0; i < n && i < 3; i++ {
			m.Weapons[i] = weaponFromJS(w.Index(i))
		}
	}
	return m
}

func weaponFromJS(o js.Value) sim.WeaponMeta {
	name := getString(o, "name")
	if name == "" {
		return sim.WeaponMeta{}
	}
	burst := int(getFloat(o, "burst"))
	if burst < 1 {
		burst = 1
	}
	return sim.WeaponMeta{
		Name:     name,
		Range:    fixed.FromFloat(getFloat(o, "rangeWU")),
		ReloadMs: int(getFloat(o, "reloadSec") * 1000),
		Burst:    burst,
		Damage:   fixed.FromFloat(getFloat(o, "damage")),
		Present:  true,

		// Ballistic / model-projectile flight fields, surfaced verbatim from the
		// weapon TDF. A weapon naming a 3DO model (and not a beam) flies through
		// the projectile subsystem; everything else hits instantly. The TDF
		// turnrate is already in TA-angle units per second.
		Model:           getString(o, "model"),
		BeamWeapon:      getBool(o, "beamWeapon"),
		VelocityWU:      fixed.FromFloat(getFloat(o, "velocityWU")),
		StartVelocityWU: fixed.FromFloat(getFloat(o, "startVelocityWU")),
		AccelerationWU:  fixed.FromFloat(getFloat(o, "accelerationWU")),
		TurnRateAng:     int32(getFloat(o, "turnRate")),
		FlightTimeSec:   fixed.FromFloat(getFloat(o, "flightTimeSec")),
		AreaOfEffectWU:  fixed.FromFloat(getFloat(o, "areaOfEffectWU")),
		Dropped:         getBool(o, "dropped"),
		VLaunch:         getBool(o, "vlaunch"),
		Tracks:          getBool(o, "tracks"),
		SelfProp:        getBool(o, "selfProp"),
		Ballistic:       getBool(o, "ballistic"),
	}
}

// orderFromJS rebuilds an order from the wire shape the networked client
// receives inside a command frame.
func orderFromJS(o js.Value) order.Order {
	ord := order.Order{
		Kind:          order.Kind(getInt(o, "Kind")),
		UnitID:        uint32(getInt(o, "UnitID")),
		TargetUnit:    uint32(getInt(o, "TargetUnit")),
		HasTargetUnit: getBool(o, "HasTargetUnit"),
		Slot:          getInt(o, "Slot"),
		Name:          getString(o, "Name"),
		Heading:       int32(getInt(o, "Heading")),
		Side:          getInt(o, "Side"),
	}
	ord.UnitIDs = uint32Slice(o.Get("UnitIDs"))
	if t := o.Get("Target"); t.Truthy() {
		ord.Target = fixed.Vec2{X: fixed.Fixed(getInt64(t, "X")), Z: fixed.Fixed(getInt64(t, "Z"))}
	}
	if t := o.Get("SpawnAt"); t.Truthy() {
		ord.SpawnAt = fixed.Vec2{X: fixed.Fixed(getInt64(t, "X")), Z: fixed.Fixed(getInt64(t, "Z"))}
	}
	return ord
}

// restoreFromJS parses an authoritative wire snapshot (the shape the server
// broadcasts on join) into the tick and unit set sim.World.Restore expects.
// Positions and health arrive as raw fixed-point integers, so they pass through
// unconverted.
func restoreFromJS(o js.Value) (uint64, []sim.RestoredUnit) {
	tick := uint64(getInt64(o, "tick"))
	arr := o.Get("units")
	if arr.Type() != js.TypeObject || arr.IsNull() {
		return tick, nil
	}
	n := arr.Length()
	units := make([]sim.RestoredUnit, 0, n)
	for i := 0; i < n; i++ {
		u := arr.Index(i)
		units = append(units, sim.RestoredUnit{
			ID:   uint32(getInt(u, "id")),
			Name: getString(u, "name"),
			Side: getInt(u, "side"),
			Pos: fixed.Vec3{
				X: fixed.Fixed(getInt64(u, "x")),
				Y: fixed.Fixed(getInt64(u, "y")),
				Z: fixed.Fixed(getInt64(u, "z")),
			},
			Heading:    fixed.Fixed(getInt64(u, "heading")),
			Speed:      fixed.Fixed(getInt64(u, "speed")),
			HasMove:    getBool(u, "hasMove"),
			MoveTarget: fixed.Vec2{X: fixed.Fixed(getInt64(u, "tx")), Z: fixed.Fixed(getInt64(u, "tz"))},
			Health:     fixed.Fixed(getInt64(u, "health")),
			Dead:       getBool(u, "dead"),
		})
	}
	return tick, units
}

// snapshotToJS marshals a render snapshot into a JS object the WebGL renderer
// consumes. Positions are floats (world units) and headings are exposed both as
// the raw TA-angle and as radians so the renderer can use whichever it already
// expects.
func snapshotToJS(s frame.Snapshot) js.Value {
	units := make([]any, 0, len(s.Units))
	for i := range s.Units {
		units = append(units, unitToJS(&s.Units[i]))
	}
	projos := make([]any, 0, len(s.Projos))
	for i := range s.Projos {
		p := &s.Projos[i]
		projos = append(projos, map[string]any{
			"id":      int(p.ID),
			"kind":    p.Kind,
			"x":       p.Pos.X.Float(),
			"y":       p.Pos.Y.Float(),
			"z":       p.Pos.Z.Float(),
			"heading": int(p.Heading),
			"pitch":   int(p.Pitch),
		})
	}
	events := make([]any, 0, len(s.Events))
	for i := range s.Events {
		events = append(events, eventToJS(&s.Events[i]))
	}
	return js.ValueOf(map[string]any{
		"tick":   int(s.Tick),
		"units":  units,
		"projos": projos,
		"events": events,
	})
}

func unitToJS(u *frame.UnitState) map[string]any {
	pieces := make([]any, 0, len(u.Pieces))
	for i := range u.Pieces {
		p := &u.Pieces[i]
		pieces = append(pieces, map[string]any{
			"ox":      p.Offset.X.Float(),
			"oy":      p.Offset.Y.Float(),
			"oz":      p.Offset.Z.Float(),
			"rx":      int(p.Rot[0]),
			"ry":      int(p.Rot[1]),
			"rz":      int(p.Rot[2]),
			"visible": p.Visible,
		})
	}
	return map[string]any{
		"id":           int(u.ID),
		"name":         u.Name,
		"side":         u.Side,
		"x":            u.Pos.X.Float(),
		"y":            u.Pos.Y.Float(),
		"z":            u.Pos.Z.Float(),
		"heading":      int(u.Heading),
		"headingRad":   fixed.AngleToRadians(u.Heading),
		"speed":        u.Speed.Float(),
		"health":       u.Health.Float(),
		"dead":         u.Dead,
		"buildPercent": u.BuildPercent.Float(),
		"isMoving":     u.IsMoving,
		"pieces":       pieces,
	}
}

// eventNames maps the engine's event kinds to the string names the JS effects
// and audio layers already listen for on the engine event bus.
var eventNames = map[frame.EventKind]string{
	frame.EvSpawn:           "spawn",
	frame.EvDespawn:         "despawn",
	frame.EvFire:            "fire",
	frame.EvHit:             "hit",
	frame.EvDeath:           "death",
	frame.EvMoveStart:       "moveStart",
	frame.EvMoveStop:        "moveStop",
	frame.EvProjectileSpawn: "projectileSpawn",
	frame.EvProjectileHit:   "projectileHit",
	frame.EvEmitSfx:         "emitSfx",
	frame.EvPlaySound:       "playSound",
	frame.EvExplode:         "explode",
}

func eventToJS(e *frame.Event) map[string]any {
	return map[string]any{
		"kind":     eventNames[e.Kind],
		"unitId":   int(e.UnitID),
		"targetId": int(e.TargetID),
		"slot":     e.Slot,
		"weapon":   e.Weapon,
		"sound":    e.Sound,
		"sfxType":  e.SfxType,
		"x":        e.Anchor.X.Float(),
		"y":        e.Anchor.Y.Float(),
		"z":        e.Anchor.Z.Float(),
	}
}

// --- small JS-value accessors -------------------------------------------------

func uint32Slice(v js.Value) []uint32 {
	if v.Type() != js.TypeObject || v.IsNull() {
		return nil
	}
	n := v.Length()
	out := make([]uint32, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, uint32(v.Index(i).Int()))
	}
	return out
}

// cobBytes copies the raw COB bytecode off a meta object's "cob" field, which
// the studio attaches as a Uint8Array. An absent or empty field yields nil, so
// the unit falls back to script-less movement/combat.
func cobBytes(o js.Value) []byte {
	v := o.Get("cob")
	if v.Type() != js.TypeObject || v.IsNull() {
		return nil
	}
	n := v.Length()
	if n <= 0 {
		return nil
	}
	b := make([]byte, n)
	js.CopyBytesToGo(b, v)
	return b
}

func getString(o js.Value, k string) string {
	v := o.Get(k)
	if v.Type() != js.TypeString {
		return ""
	}
	return v.String()
}

func getFloat(o js.Value, k string) float64 {
	v := o.Get(k)
	if v.Type() != js.TypeNumber {
		return 0
	}
	return v.Float()
}

func getInt(o js.Value, k string) int {
	v := o.Get(k)
	if v.Type() != js.TypeNumber {
		return 0
	}
	return v.Int()
}

func getInt64(o js.Value, k string) int64 {
	v := o.Get(k)
	if v.Type() != js.TypeNumber {
		return 0
	}
	return int64(v.Float())
}

func getBool(o js.Value, k string) bool {
	return o.Get(k).Truthy()
}

func formatUint(u uint64) string { return strconv.FormatUint(u, 10) }
