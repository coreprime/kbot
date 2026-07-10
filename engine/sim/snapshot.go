package sim

import "github.com/coreprime/kbot/engine/frame"

// Snapshot builds the render snapshot for the current tick and drains the
// events accumulated since the last call. The local renderer consumes this; it
// never crosses the wire.
func (w *World) Snapshot() frame.Snapshot {
	units := make([]frame.UnitState, 0, len(w.order))
	for _, id := range w.order {
		u := w.units[id]
		if u == nil {
			continue
		}
		var pieces []frame.PieceState
		if u.binding != nil {
			pieces = u.binding.Pieces()
		}
		var selfDMs int64
		if u.selfDAtMs > 0 {
			if selfDMs = u.selfDAtMs - w.simMs; selfDMs < 0 {
				selfDMs = 0
			}
		}
		var queue []frame.QueuedOrder
		if len(u.queue) > 0 {
			queue = make([]frame.QueuedOrder, 0, len(u.queue))
			for _, c := range u.queue {
				queue = append(queue, frame.QueuedOrder{Kind: uint8(c.kind), Target: c.target, TargetUnit: c.targetUnit, Name: c.name})
			}
		}
		units = append(units, frame.UnitState{
			ID:      u.ID,
			Name:    u.Name,
			Side:    u.Side,
			Pos:     u.Pos(),
			Heading: int32(u.loco.Heading.Int()),
			// The wire/render speed contract stays wu per second; the sim
			// holds the engines' per-frame scalar internally.
			Speed:          u.loco.Speed.Mul(fxTickHz),
			Health:         u.Health,
			Dead:           u.Dead,
			BuildPercent:   u.BuildPercent,
			IsMoving:       u.IsMoving,
			Pieces:         pieces,
			HasMove:        u.hasMove,
			MoveTarget:     u.moveTarget,
			Queue:          queue,
			Building:       u.buildName,
			ProdQueue:      u.prodQueue,
			MoveMode:       u.moveMode,
			FireMode:       u.fireMode,
			SelfDestructMs: selfDMs,
			CarriedBy:      u.carriedBy,
			Carrying:       u.carrying,
		})
	}
	var projos []frame.ProjectileState
	if len(w.projectiles) > 0 {
		projos = make([]frame.ProjectileState, 0, len(w.projectiles))
		for _, p := range w.projectiles {
			projos = append(projos, frame.ProjectileState{
				ID:        p.id,
				Kind:      p.model,
				Pos:       p.pos,
				Heading:   p.heading,
				Pitch:     p.pitch,
				OwnerID:   p.ownerID,
				TargetID:  p.targetID,
				Weapon:    p.weapon,
				Mode:      p.mode.String(),
				Vel:       p.vel,
				Origin:    p.origin,
				Target:    p.target,
				Speed:     p.speed,
				AgeSec:    p.ageSec,
				LifeSec:   p.lifeSec,
				FromPiece: int32(p.fromPiece),
			})
		}
	}
	var resources []frame.ResourceState
	for side := 0; side < maxSides; side++ {
		s, r := w.resSpent[side], w.resRate[side]
		st, c, g := w.resStock[side], w.resCap[side], w.resGen[side]
		if s == (resourceTally{}) && r == (resourceTally{}) &&
			c == (resourceTally{}) && g == (resourceTally{}) {
			continue
		}
		resources = append(resources, frame.ResourceState{
			Side:           side,
			MetalSpent:     s.Metal,
			EnergySpent:    s.Energy,
			ManaSpent:      s.Mana,
			MetalRate:      r.Metal,
			EnergyRate:     r.Energy,
			ManaRate:       r.Mana,
			MetalStock:     st.Metal,
			EnergyStock:    st.Energy,
			ManaStock:      st.Mana,
			MetalCap:       c.Metal,
			EnergyCap:      c.Energy,
			ManaCap:        c.Mana,
			MetalGen:       g.Metal,
			EnergyGen:      g.Energy,
			ManaGen:        g.Mana,
			MetalProduced:  w.resProduced[side].Metal,
			EnergyProduced: w.resProduced[side].Energy,
			ManaProduced:   w.resProduced[side].Mana,
		})
	}
	evts := w.events
	w.events = nil
	return frame.Snapshot{
		Tick:      w.tick,
		Units:     units,
		Projos:    projos,
		Events:    evts,
		Resources: resources,
	}
}

// Hash returns a deterministic digest of the authoritative unit state. The
// server broadcasts it periodically and clients compare against their own to
// detect prediction divergence. Iteration follows the stable insertion order.
func (w *World) Hash() uint64 {
	const (
		offset uint64 = 1469598103934665603
		prime  uint64 = 1099511628211
	)
	h := offset
	mix := func(v uint64) {
		for i := 0; i < 8; i++ {
			h ^= v & 0xff
			h *= prime
			v >>= 8
		}
	}
	mix(w.tick)
	for _, id := range w.order {
		u := w.units[id]
		if u == nil {
			continue
		}
		mix(uint64(id))
		mix(uint64(u.loco.Pos.X))
		mix(uint64(u.loco.Pos.Z))
		mix(uint64(u.PosY))
		mix(uint64(u.loco.Heading))
		mix(uint64(u.Health))
		if u.Dead {
			mix(1)
		}
		// Build progress is authoritative — it gates when a buildee becomes
		// commandable — as are the builder's job state and a factory's
		// pending production run.
		mix(uint64(u.BuildPercent))
		mix(uint64(u.buildState))
		mix(uint64(u.buildGateMs))
		// Standing orders steer autonomous behaviour, so a divergent stance
		// or post must surface as a desync.
		mix(uint64(u.moveMode)<<8 | uint64(u.fireMode))
		mix(uint64(u.homePos.X))
		mix(uint64(u.homePos.Z))
		if u.curIsPatrol {
			mix(2)
		}
		if u.autoEngaged {
			mix(3)
		}
		// A replay motion pin steers evolution (IsMoving + heading coast), so
		// divergent pins must surface as a desync. Mixed only when set, so
		// worlds that never pin — every live game — hash exactly as before.
		if u.motionPin != motionPinNone {
			mix(uint64(0xB0) + uint64(u.motionPin))
		}
		mix(uint64(u.selfDAtMs))
		// Transport links are authoritative: a passenger rides its carrier.
		mix(uint64(u.carriedBy))
		mix(uint64(u.loadTarget))
		mix(uint64(u.stallTicks))
		mix(uint64(u.progressPos.X))
		mix(uint64(u.progressPos.Z))
		if u.avoidFlip {
			mix(1)
		} else {
			mix(0)
		}
		if u.hasUnload {
			mix(4)
			mix(uint64(u.unloadAt.X))
			mix(uint64(u.unloadAt.Z))
		}
		mix(uint64(len(u.carrying)))
		for _, cid := range u.carrying {
			mix(uint64(cid))
		}
		mix(uint64(len(u.prodQueue)))
		for _, name := range u.prodQueue {
			for i := 0; i < len(name); i++ {
				mix(uint64(name[i]))
			}
		}
		// The shift-queue is authoritative — it dictates where the unit goes
		// next — so a divergent queue must surface as a desync.
		mix(uint64(len(u.queue)))
		for _, c := range u.queue {
			mix(uint64(c.kind))
			mix(uint64(c.target.X))
			mix(uint64(c.target.Z))
			mix(uint64(c.targetUnit))
			for i := 0; i < len(c.name); i++ {
				mix(uint64(c.name[i]))
			}
		}
	}
	return h
}
