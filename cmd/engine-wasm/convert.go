//go:build js && wasm

package main

import (
	"encoding/binary"
	"math"
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
		IsHovercraft: getBool(o, "isHovercraft"),
		IsBuilder:   getBool(o, "isBuilder"),
		OnOffable:   getBool(o, "onoffable"),
		ActivateWhenBuilt: getBool(o, "activateWhenBuilt"),
	}
	m.BuildTime = fixed.FromFloat(getFloat(o, "buildTime"))
	m.WorkerTime = getInt(o, "workerTime")
	m.BuildDistance = fixed.FromFloat(getFloat(o, "buildDistance"))
	m.FootprintX = getInt(o, "footprintX")
	m.FootprintZ = getInt(o, "footprintZ")
	m.Yard = sim.ParseYardMap(getString(o, "yardMap"), m.FootprintX, m.FootprintZ)
	m.TransportSlots = getInt(o, "transportSlots")
	m.MaxSlope = getInt(o, "maxSlope")
	m.MaxWaterDepth = getInt(o, "maxWaterDepth")
	m.MinWaterDepth = getInt(o, "minWaterDepth")
	m.CostMetal = fixed.FromFloat(getFloat(o, "costMetal"))
	m.CostEnergy = fixed.FromFloat(getFloat(o, "costEnergy"))
	m.CostMana = fixed.FromFloat(getFloat(o, "costMana"))
	// 0 / absent means "game default" — AddUnit resolves it (Maneuver /
	// Fire at Will).
	m.StandMove = uint8(getInt(o, "standingMoveOrder"))
	m.StandFire = uint8(getInt(o, "standingFireOrder"))
	m.Explode = blastFromJS(o.Get("explodeWeapon"))
	m.SelfD = blastFromJS(o.Get("selfDestructWeapon"))
	m.MakeMetal = fixed.FromFloat(getFloat(o, "makesMetal"))
	m.MakeEnergy = fixed.FromFloat(getFloat(o, "makesEnergy"))
	m.MakeMana = fixed.FromFloat(getFloat(o, "makesMana"))
	m.StoreMetal = fixed.FromFloat(getFloat(o, "storesMetal"))
	m.StoreEnergy = fixed.FromFloat(getFloat(o, "storesEnergy"))
	m.StoreMana = fixed.FromFloat(getFloat(o, "storesMana"))
	m.CruiseAltitude = fixed.FromFloat(getFloat(o, "cruiseAltitude"))
	m.MaxHealth = fixed.FromFloat(getFloat(o, "maxDamage"))
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
		// damageDefault is the [DAMAGE] table's `default=` — the weapon's
		// absolute per-shot damage (the `damage` key is the per-target map).
		Damage:  fixed.FromFloat(getFloat(o, "damageDefault")),
		Present: true,

		// Firing arc (TA-angle units): aircraft must point the airframe within
		// this of the target bearing before the weapon opens fire.
		Tolerance: int32(getFloat(o, "tolerance")),

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

// blastFromJS reads a resolved death-blast stat block off the unit meta.
func blastFromJS(o js.Value) sim.Blast {
	if o.Type() != js.TypeObject || o.IsNull() {
		return sim.Blast{}
	}
	return sim.Blast{
		Damage: fixed.FromFloat(getFloat(o, "damage")),
		AoE:    fixed.FromFloat(getFloat(o, "areaOfEffectWU")),
		Edge:   fixed.FromFloat(getFloat(o, "edgeEffectiveness")),
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
		Queued:        getBool(o, "Queued"),
		Slot:          getInt(o, "Slot"),
		Name:          getString(o, "Name"),
		Heading:       int32(getInt(o, "Heading")),
		Side:          getInt(o, "Side"),
		MoveMode:      getInt(o, "MoveMode"),
		FireMode:      getInt(o, "FireMode"),
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
// broadcasts on join) into the tick, unit set and in-flight projectiles
// sim.World.Restore expects. Positions and health arrive as raw fixed-point
// integers, so they pass through unconverted.
func restoreFromJS(o js.Value) (uint64, []sim.RestoredUnit, []sim.RestoredProjectile, uint32) {
	tick := uint64(getInt64(o, "tick"))
	arr := o.Get("units")
	var units []sim.RestoredUnit
	if arr.Type() == js.TypeObject && !arr.IsNull() {
		n := arr.Length()
		units = make([]sim.RestoredUnit, 0, n)
		for i := 0; i < n; i++ {
			u := arr.Index(i)
			ru := sim.RestoredUnit{
				ID:   uint32(getInt(u, "id")),
				Name: getString(u, "name"),
				Side: getInt(u, "side"),
				Pos: fixed.Vec3{
					X: fixed.Fixed(getInt64(u, "x")),
					Y: fixed.Fixed(getInt64(u, "y")),
					Z: fixed.Fixed(getInt64(u, "z")),
				},
				Heading:       fixed.Fixed(getInt64(u, "heading")),
				Speed:         fixed.Fixed(getInt64(u, "speed")),
				HasMove:       getBool(u, "hasMove"),
				MoveTarget:    fixed.Vec2{X: fixed.Fixed(getInt64(u, "tx")), Z: fixed.Fixed(getInt64(u, "tz"))},
				Health:        fixed.Fixed(getInt64(u, "health")),
				Dead:          getBool(u, "dead"),
				HasAttack:     getBool(u, "hasAttack"),
				AttackTarget:  uint32(getInt(u, "attackTarget")),
				BuildPercent:  fixed.Fixed(getInt64(u, "buildPercent")),
				BuildState:    uint8(getInt(u, "buildState")),
				BuildName:     getString(u, "buildName"),
				BuildSite:     fixed.Vec2{X: fixed.Fixed(getInt64(u, "buildSiteX")), Z: fixed.Fixed(getInt64(u, "buildSiteZ"))},
				BuildTargetID: uint32(getInt(u, "buildTargetId")),
				BuildGateMs:   getInt64(u, "buildGateMs"),
				ProdQueue:     stringSliceFromJS(u.Get("prodQueue")),
				MoveMode:      uint8(getInt(u, "moveMode")),
				FireMode:      uint8(getInt(u, "fireMode")),
				HomePos:       fixed.Vec2{X: fixed.Fixed(getInt64(u, "homeX")), Z: fixed.Fixed(getInt64(u, "homeZ"))},
				AutoEngaged:   getBool(u, "autoEngaged"),
				CurIsPatrol:   getBool(u, "curIsPatrol"),
				SelfDAtMs:     getInt64(u, "selfDAtMs"),
				CarriedBy:     uint32(getInt(u, "carriedBy")),
				LoadTarget:    uint32(getInt(u, "loadTarget")),
				HasUnload:     getBool(u, "hasUnload"),
				UnloadAt:      fixed.Vec2{X: fixed.Fixed(getInt64(u, "unloadX")), Z: fixed.Fixed(getInt64(u, "unloadZ"))},
			}
			if cs := u.Get("carrying"); cs.Type() == js.TypeObject && !cs.IsNull() {
				for i := 0; i < cs.Length(); i++ {
					ru.Carrying = append(ru.Carrying, uint32(cs.Index(i).Int()))
				}
			}
			if qs := u.Get("queue"); qs.Type() == js.TypeObject && !qs.IsNull() {
				for i := 0; i < qs.Length(); i++ {
					q := qs.Index(i)
					ru.Queue = append(ru.Queue, sim.RestoredQueued{
						Kind:       uint8(getInt(q, "kind")),
						Target:     fixed.Vec2{X: fixed.Fixed(getInt64(q, "tx")), Z: fixed.Fixed(getInt64(q, "tz"))},
						TargetUnit: uint32(getInt(q, "targetUnit")),
						Name:       getString(q, "name"),
					})
				}
			}
			if ws := u.Get("weapons"); ws.Type() == js.TypeObject && !ws.IsNull() {
				for s := 0; s < len(ru.Weapons) && s < ws.Length(); s++ {
					w := ws.Index(s)
					ru.Weapons[s] = sim.RestoredWeapon{
						HasTarget:  getBool(w, "hasTarget"),
						TargetUnit: uint32(getInt(w, "targetUnit")),
						TargetPt: fixed.Vec3{
							X: fixed.Fixed(getInt64(w, "px")),
							Y: fixed.Fixed(getInt64(w, "py")),
							Z: fixed.Fixed(getInt64(w, "pz")),
						},
						Source:     getString(w, "source"),
						LastFireMs: getInt64(w, "lastFireMs"),
					}
				}
			}
			ru.Cob = cobFromJS(u.Get("cob"))
			units = append(units, ru)
		}
	}
	return tick, units, projectilesFromJS(o.Get("projectiles")), uint32(getInt64(o, "runtimeRng"))
}

// cobFromJS parses a unit's live COB VM state from a join snapshot into the
// neutral frame.CobSnapshot the sim hands the script binding's ImportCob. A
// missing or null "cob" (a periodic backstop snapshot, or a script-less unit)
// yields nil, so the joiner falls back to replaying Create/StartMoving.
func cobFromJS(o js.Value) *frame.CobSnapshot {
	if o.Type() != js.TypeObject || o.IsNull() {
		return nil
	}
	snap := &frame.CobSnapshot{
		Static: int32SliceFromJS(o.Get("static")),
		Hidden: intSliceFromJS(o.Get("hidden")),
		NextID: int32(getInt(o, "nextId")),
	}
	if a := o.Get("anims"); a.Type() == js.TypeObject && !a.IsNull() {
		n := a.Length()
		snap.Anims = make([]frame.CobAnimSnap, 0, n)
		for i := 0; i < n; i++ {
			e := a.Index(i)
			snap.Anims = append(snap.Anims, frame.CobAnimSnap{
				Key:    getInt(e, "key"),
				Kind:   getInt(e, "kind"),
				Value:  getInt64(e, "value"),
				Target: getInt64(e, "target"),
				Speed:  getInt64(e, "speed"),
				Decel:  getInt64(e, "decel"),
				Done:   getBool(e, "done"),
			})
		}
	}
	if th := o.Get("threads"); th.Type() == js.TypeObject && !th.IsNull() {
		n := th.Length()
		snap.Threads = make([]frame.CobThreadSnap, 0, n)
		for i := 0; i < n; i++ {
			t := th.Index(i)
			ts := frame.CobThreadSnap{
				ID:          int32(getInt(t, "id")),
				ScriptIndex: getInt(t, "scriptIndex"),
				PC:          getInt(t, "pc"),
				Stack:       int32SliceFromJS(t.Get("stack")),
				Locals:      int32SliceFromJS(t.Get("locals")),
				SignalMask:  int32(getInt(t, "signalMask")),
				SleepMs:     getInt64(t, "sleepMs"),
				Waiting:     getBool(t, "waiting"),
				WaitRot:     getBool(t, "waitRot"),
				WaitKey:     getInt(t, "waitKey"),
				ReturnValue: int32(getInt(t, "returnValue")),
			}
			if cs := t.Get("callStack"); cs.Type() == js.TypeObject && !cs.IsNull() {
				cn := cs.Length()
				ts.CallStack = make([]frame.CobCallFrame, 0, cn)
				for j := 0; j < cn; j++ {
					cf := cs.Index(j)
					ts.CallStack = append(ts.CallStack, frame.CobCallFrame{
						ScriptIndex: getInt(cf, "scriptIndex"),
						PC:          getInt(cf, "pc"),
						Locals:      int32SliceFromJS(cf.Get("locals")),
					})
				}
			}
			snap.Threads = append(snap.Threads, ts)
		}
	}
	return snap
}

// int32SliceFromJS copies a JS number array into an []int32, returning nil for a
// missing or null array (the omitempty case).
func int32SliceFromJS(arr js.Value) []int32 {
	if arr.Type() != js.TypeObject || arr.IsNull() {
		return nil
	}
	n := arr.Length()
	out := make([]int32, n)
	for i := 0; i < n; i++ {
		out[i] = int32(arr.Index(i).Int())
	}
	return out
}

// stringSliceFromJS copies a JS string array into a []string, returning nil
// for a missing or null array.
func stringSliceFromJS(arr js.Value) []string {
	if arr.Type() != js.TypeObject || arr.IsNull() {
		return nil
	}
	n := arr.Length()
	out := make([]string, n)
	for i := 0; i < n; i++ {
		out[i] = arr.Index(i).String()
	}
	return out
}

// intSliceFromJS copies a JS number array into an []int, returning nil for a
// missing or null array.
func intSliceFromJS(arr js.Value) []int {
	if arr.Type() != js.TypeObject || arr.IsNull() {
		return nil
	}
	n := arr.Length()
	out := make([]int, n)
	for i := 0; i < n; i++ {
		out[i] = arr.Index(i).Int()
	}
	return out
}

// projectilesFromJS rebuilds the in-flight model weapons carried in a join
// snapshot. Every field is a raw fixed-point integer or plain scalar, so the
// flight record passes through unconverted.
func projectilesFromJS(arr js.Value) []sim.RestoredProjectile {
	if arr.Type() != js.TypeObject || arr.IsNull() {
		return nil
	}
	n := arr.Length()
	out := make([]sim.RestoredProjectile, 0, n)
	for i := 0; i < n; i++ {
		p := arr.Index(i)
		out = append(out, sim.RestoredProjectile{
			ID:       uint32(getInt(p, "id")),
			OwnerID:  uint32(getInt(p, "ownerId")),
			TargetID: uint32(getInt(p, "targetId")),
			Slot:     getInt(p, "slot"),
			Mode:     uint8(getInt(p, "mode")),
			Phase:    uint8(getInt(p, "phase")),
			Model:    getString(p, "model"),
			Weapon:   getString(p, "weapon"),
			Pos:      fixed.Vec3{X: fixed.Fixed(getInt64(p, "x")), Y: fixed.Fixed(getInt64(p, "y")), Z: fixed.Fixed(getInt64(p, "z"))},
			Vel:      fixed.Vec3{X: fixed.Fixed(getInt64(p, "vx")), Y: fixed.Fixed(getInt64(p, "vy")), Z: fixed.Fixed(getInt64(p, "vz"))},
			Origin:   fixed.Vec3{X: fixed.Fixed(getInt64(p, "ox")), Y: fixed.Fixed(getInt64(p, "oy")), Z: fixed.Fixed(getInt64(p, "oz"))},
			Target:   fixed.Vec3{X: fixed.Fixed(getInt64(p, "tx")), Y: fixed.Fixed(getInt64(p, "ty")), Z: fixed.Fixed(getInt64(p, "tz"))},
			LaunchY:  fixed.Fixed(getInt64(p, "launchY")),
			Speed:    fixed.Fixed(getInt64(p, "speed")),
			VMax:     fixed.Fixed(getInt64(p, "vmax")),
			Accel:    fixed.Fixed(getInt64(p, "accel")),
			TurnAng:  int32(getInt(p, "turnAng")),
			HomingR:  fixed.Fixed(getInt64(p, "homingR")),
			Gravity:  fixed.Fixed(getInt64(p, "gravity")),
			AoE:      fixed.Fixed(getInt64(p, "aoe")),
			Damage:   fixed.Fixed(getInt64(p, "damage")),
			AgeSec:   fixed.Fixed(getInt64(p, "ageSec")),
			LifeSec:  fixed.Fixed(getInt64(p, "lifeSec")),
			LastDist: fixed.Fixed(getInt64(p, "lastDist")),
			Closing:  getBool(p, "closing"),
			Heading:  int32(getInt(p, "heading")),
			Pitch:    int32(getInt(p, "pitch")),
		})
	}
	return out
}

// snapshotToWireJS marshals the world's authoritative export into the same shape
// the server's wire.Snapshot serializes to (raw fixed-point integers as JS
// numbers, identical field names). The Network panel's Diagnose feature diffs
// this client-side snapshot field-by-field against the server's, so the two must
// be byte-comparable: every position/health/velocity stays a raw Q16.16 integer
// rather than being converted to world-unit floats. Read-only / debug-only.
func snapshotToWireJS(inst *instance) js.Value {
	w := inst.world
	units := make([]any, 0)
	for _, ru := range w.ExportUnits() {
		weapons := make([]any, len(ru.Weapons))
		for i := range ru.Weapons {
			rw := ru.Weapons[i]
			weapons[i] = map[string]any{
				"hasTarget":  rw.HasTarget,
				"targetUnit": int(rw.TargetUnit),
				"px":         float64(rw.TargetPt.X),
				"py":         float64(rw.TargetPt.Y),
				"pz":         float64(rw.TargetPt.Z),
				"source":     rw.Source,
				"lastFireMs": float64(rw.LastFireMs),
			}
		}
		entry := map[string]any{
			"id":           int(ru.ID),
			"name":         ru.Name,
			"side":         ru.Side,
			"x":            float64(ru.Pos.X),
			"y":            float64(ru.Pos.Y),
			"z":            float64(ru.Pos.Z),
			"heading":      float64(ru.Heading),
			"speed":        float64(ru.Speed),
			"hasMove":      ru.HasMove,
			"tx":           float64(ru.MoveTarget.X),
			"tz":           float64(ru.MoveTarget.Z),
			"health":       float64(ru.Health),
			"dead":         ru.Dead,
			"hasAttack":    ru.HasAttack,
			"attackTarget": int(ru.AttackTarget),
			"weapons":      weapons,
			"buildPercent": float64(ru.BuildPercent),
			"moveMode":     int(ru.MoveMode),
			"fireMode":     int(ru.FireMode),
			"homeX":        float64(ru.HomePos.X),
			"homeZ":        float64(ru.HomePos.Z),
		}
		// Mirror the wire's omitempty flags.
		if ru.AutoEngaged {
			entry["autoEngaged"] = true
		}
		if ru.CurIsPatrol {
			entry["curIsPatrol"] = true
		}
		if ru.SelfDAtMs != 0 {
			entry["selfDAtMs"] = float64(ru.SelfDAtMs)
		}
		if ru.CarriedBy != 0 {
			entry["carriedBy"] = int(ru.CarriedBy)
		}
		if len(ru.Carrying) > 0 {
			ids := make([]any, len(ru.Carrying))
			for i, cid := range ru.Carrying {
				ids[i] = int(cid)
			}
			entry["carrying"] = ids
		}
		if ru.LoadTarget != 0 {
			entry["loadTarget"] = int(ru.LoadTarget)
		}
		if ru.HasUnload {
			entry["hasUnload"] = true
			entry["unloadX"] = float64(ru.UnloadAt.X)
			entry["unloadZ"] = float64(ru.UnloadAt.Z)
		}
		if ru.BuildState != 0 {
			entry["buildState"] = int(ru.BuildState)
			entry["buildName"] = ru.BuildName
			entry["buildSiteX"] = float64(ru.BuildSite.X)
			entry["buildSiteZ"] = float64(ru.BuildSite.Z)
			entry["buildTargetId"] = int(ru.BuildTargetID)
		}
		if ru.BuildGateMs != 0 {
			entry["buildGateMs"] = float64(ru.BuildGateMs)
		}
		if len(ru.ProdQueue) > 0 {
			pq := make([]any, len(ru.ProdQueue))
			for i, n := range ru.ProdQueue {
				pq[i] = n
			}
			entry["prodQueue"] = pq
		}
		// Mirror the wire's omitempty: only a non-empty queue serializes, so
		// the Diagnose field diff stays symmetric with the server snapshot.
		if len(ru.Queue) > 0 {
			queue := make([]any, len(ru.Queue))
			for i, q := range ru.Queue {
				entryQ := map[string]any{
					"kind":       int(q.Kind),
					"tx":         float64(q.Target.X),
					"tz":         float64(q.Target.Z),
					"targetUnit": int(q.TargetUnit),
				}
				if q.Name != "" {
					entryQ["name"] = q.Name
				}
				queue[i] = entryQ
			}
			entry["queue"] = queue
		}
		units = append(units, entry)
	}
	projos := make([]any, 0)
	for _, rp := range w.ExportProjectiles() {
		projos = append(projos, map[string]any{
			"id":        int(rp.ID),
			"ownerId":   int(rp.OwnerID),
			"targetId":  int(rp.TargetID),
			"slot":      rp.Slot,
			"mode":      int(rp.Mode),
			"phase":     int(rp.Phase),
			"model":     rp.Model,
			"weapon":    rp.Weapon,
			"x":         float64(rp.Pos.X),
			"y":         float64(rp.Pos.Y),
			"z":         float64(rp.Pos.Z),
			"vx":        float64(rp.Vel.X),
			"vy":        float64(rp.Vel.Y),
			"vz":        float64(rp.Vel.Z),
			"ox":        float64(rp.Origin.X),
			"oy":        float64(rp.Origin.Y),
			"oz":        float64(rp.Origin.Z),
			"tx":        float64(rp.Target.X),
			"ty":        float64(rp.Target.Y),
			"tz":        float64(rp.Target.Z),
			"launchY":   float64(rp.LaunchY),
			"speed":     float64(rp.Speed),
			"vmax":      float64(rp.VMax),
			"accel":     float64(rp.Accel),
			"turnAng":   int(rp.TurnAng),
			"homingR":   float64(rp.HomingR),
			"gravity":   float64(rp.Gravity),
			"aoe":       float64(rp.AoE),
			"damage":    float64(rp.Damage),
			"ageSec":    float64(rp.AgeSec),
			"lifeSec":   float64(rp.LifeSec),
			"lastDist":  float64(rp.LastDist),
			"closing":   rp.Closing,
			"heading":   int(rp.Heading),
			"pitch":     int(rp.Pitch),
			"fromPiece": rp.FromPiece,
		})
	}
	return js.ValueOf(map[string]any{
		"tick":        int(w.Tick()),
		"hash":        formatUint(w.Hash()),
		"units":       units,
		"projectiles": projos,
	})
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
			"id":        int(p.ID),
			"kind":      p.Kind,
			"x":         p.Pos.X.Float(),
			"y":         p.Pos.Y.Float(),
			"z":         p.Pos.Z.Float(),
			"heading":   int(p.Heading),
			"pitch":     int(p.Pitch),
			"fromPiece": int(p.FromPiece),
			// Inspection fields the Projectiles panel reads to plot the
			// launch→aim track and label the shot.
			"ownerId":      int(p.OwnerID),
			"targetUnitId": int(p.TargetID),
			"weapon":       p.Weapon,
			"mode":         p.Mode,
			"vx":           p.Vel.X.Float(),
			"vy":           p.Vel.Y.Float(),
			"vz":           p.Vel.Z.Float(),
			"ox":           p.Origin.X.Float(),
			"oy":           p.Origin.Y.Float(),
			"oz":           p.Origin.Z.Float(),
			"tx":           p.Target.X.Float(),
			"ty":           p.Target.Y.Float(),
			"tz":           p.Target.Z.Float(),
			"speed":        p.Speed.Float(),
			"age":          p.AgeSec.Float(),
			"life":         p.LifeSec.Float(),
		})
	}
	events := make([]any, 0, len(s.Events))
	for i := range s.Events {
		events = append(events, eventToJS(&s.Events[i]))
	}
	out := map[string]any{
		"tick":   int(s.Tick),
		"units":  units,
		"projos": projos,
		"events": events,
	}
	// Per-side resource usage for the HUD (infinite pools — display only).
	if len(s.Resources) > 0 {
		res := make([]any, 0, len(s.Resources))
		for i := range s.Resources {
			r := &s.Resources[i]
			res = append(res, map[string]any{
				"side":        r.Side,
				"metalSpent":  r.MetalSpent.Float(),
				"energySpent": r.EnergySpent.Float(),
				"manaSpent":   r.ManaSpent.Float(),
				"metalRate":   r.MetalRate.Float(),
				"energyRate":  r.EnergyRate.Float(),
				"manaRate":    r.ManaRate.Float(),
				"metalStock":  r.MetalStock.Float(),
				"energyStock": r.EnergyStock.Float(),
				"manaStock":   r.ManaStock.Float(),
				"metalCap":    r.MetalCap.Float(),
				"energyCap":   r.EnergyCap.Float(),
				"manaCap":     r.ManaCap.Float(),
				"metalGen":    r.MetalGen.Float(),
				"energyGen":   r.EnergyGen.Float(),
				"manaGen":     r.ManaGen.Float(),
				"metalProduced":  r.MetalProduced.Float(),
				"energyProduced": r.EnergyProduced.Float(),
				"manaProduced":   r.ManaProduced.Float(),
			})
		}
		out["resources"] = res
	}
	return js.ValueOf(out)
}

func unitToJS(u *frame.UnitState) map[string]any {
	pieces := piecesToPackedJS(u.Pieces)
	out := map[string]any{
		"id":             int(u.ID),
		"name":           u.Name,
		"side":           u.Side,
		"x":              u.Pos.X.Float(),
		"y":              u.Pos.Y.Float(),
		"z":              u.Pos.Z.Float(),
		"heading":        int(u.Heading),
		"headingRad":     fixed.AngleToRadians(u.Heading),
		"speed":          u.Speed.Float(),
		"health":         u.Health.Float(),
		"dead":           u.Dead,
		"buildPercent":   u.BuildPercent.Float(),
		"isMoving":       u.IsMoving,
		"hasMove":        u.HasMove,
		"moveX":          u.MoveTarget.X.Float(),
		"moveZ":          u.MoveTarget.Z.Float(),
		"moveMode":       int(u.MoveMode),
		"fireMode":       int(u.FireMode),
		"selfDestructMs": int(u.SelfDestructMs),
		"piecesPacked":   pieces,
	}
	// Transport links, for the cargo badge + carried-unit gestures.
	if u.CarriedBy != 0 {
		out["carriedBy"] = int(u.CarriedBy)
	}
	if len(u.Carrying) > 0 {
		ids := make([]any, len(u.Carrying))
		for i, cid := range u.Carrying {
			ids[i] = int(cid)
		}
		out["carrying"] = ids
	}
	// Production state, for the build-menu counters: the type currently
	// raising on the pad plus the factory's pending run in click order.
	if u.Building != "" {
		out["building"] = u.Building
	}
	if len(u.ProdQueue) > 0 {
		pq := make([]any, len(u.ProdQueue))
		for i, n := range u.ProdQueue {
			pq[i] = n
		}
		out["prodQueue"] = pq
	}
	// Queued follow-up orders, for the order overlay's waypoint chain. kind
	// follows order.Kind: 1 = move (x/z destination), 2 = attack (targetId).
	if len(u.Queue) > 0 {
		queue := make([]any, len(u.Queue))
		for i, q := range u.Queue {
			entry := map[string]any{
				"kind":     int(q.Kind),
				"x":        q.Target.X.Float(),
				"z":        q.Target.Z.Float(),
				"targetId": int(q.TargetUnit),
			}
			if q.Name != "" {
				entry["name"] = q.Name
			}
			queue[i] = entry
		}
		out["queue"] = queue
	}
	return out
}

// pieceScratch is the reused pack buffer piecesToPackedJS fills each call,
// so the per-tick marshal allocates nothing on the Go side.
var pieceScratch []byte

// piecesToPackedJS packs a unit's piece transforms into a Float32 stride-7
// buffer (ox, oy, oz, rx, ry, rz, visible) handed to JS as a single
// Uint8Array — one allocation and one memcpy instead of one JS map per
// piece, which dominated the bridge cost on busy fields.
func piecesToPackedJS(pieces []frame.PieceState) js.Value {
	need := len(pieces) * 7 * 4
	if need == 0 {
		return js.Null()
	}
	if cap(pieceScratch) < need {
		pieceScratch = make([]byte, need)
	}
	buf := pieceScratch[:need]
	off := 0
	put := func(f float32) {
		binary.LittleEndian.PutUint32(buf[off:], math.Float32bits(f))
		off += 4
	}
	for i := range pieces {
		p := &pieces[i]
		put(float32(p.Offset.X.Float()))
		put(float32(p.Offset.Y.Float()))
		put(float32(p.Offset.Z.Float()))
		put(float32(p.Rot[0]))
		put(float32(p.Rot[1]))
		put(float32(p.Rot[2]))
		if p.Visible {
			put(1)
		} else {
			put(0)
		}
	}
	arr := js.Global().Get("Uint8Array").New(need)
	js.CopyBytesToJS(arr, buf)
	return arr
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
	frame.EvCorpseSpawn:     "corpseSpawn",
	frame.EvBuildStart:      "buildStart",
	frame.EvBuildStop:       "buildStop",
	frame.EvBlast:           "blast",
}

func eventToJS(e *frame.Event) map[string]any {
	return map[string]any{
		"kind":      eventNames[e.Kind],
		"unitId":    int(e.UnitID),
		"targetId":  int(e.TargetID),
		"slot":      e.Slot,
		"weapon":    e.Weapon,
		"sound":     e.Sound,
		"sfxType":   e.SfxType,
		"x":         e.Anchor.X.Float(),
		"y":         e.Anchor.Y.Float(),
		"z":         e.Anchor.Z.Float(),
		"tx":        e.Target.X.Float(),
		"ty":        e.Target.Y.Float(),
		"tz":        e.Target.Z.Float(),
		"fromPiece": int(e.FromPiece),
	}
}

// i32SliceToJS converts a static-variable slice into a plain JS number array
// the Script Variables panel renders row-by-row.
func i32SliceToJS(vs []int32) []any {
	out := make([]any, len(vs))
	for i, v := range vs {
		out[i] = int(v)
	}
	return out
}

// cobThreadsToJS marshals the per-thread inspection summary into the shape the
// Runtime panel's thread rows consume.
func cobThreadsToJS(ts []frame.CobThread) []any {
	out := make([]any, 0, len(ts))
	for i := range ts {
		t := &ts[i]
		out = append(out, map[string]any{
			"id":            t.ID,
			"script":        t.Script,
			"pc":            t.PC,
			"offset":        t.Offset,
			"sleepMs":       t.SleepMs,
			"waiting":       t.Waiting,
			"waitTurn":      t.WaitTurn,
			"signalMask":    t.SignalMask,
			"locals":        i32SliceToJS(t.Locals),
			"stack":         i32SliceToJS(t.Stack),
			"breakpointHit": t.BreakpointHit,
		})
	}
	return out
}

// coverageToJS converts the executed-offset coverage map into a plain JS object
// keyed by script index (as a decimal string) → array of byte offsets, the shape
// the debugger's coverage-dimming view consumes.
func coverageToJS(cov map[int][]uint32) js.Value {
	out := make(map[string]any, len(cov))
	for idx, offs := range cov {
		arr := make([]any, len(offs))
		for i, off := range offs {
			arr[i] = int(off)
		}
		out[strconv.Itoa(idx)] = arr
	}
	return js.ValueOf(out)
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
