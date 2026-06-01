package script

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
)

// ExportCob captures the unit's full live VM state — statics, active animators,
// hidden pieces, running threads and the thread-id counter — so a late joiner
// can resume the exact piece poses (turret aim, rotation, mid-animation) the
// authority holds rather than re-deriving them by replaying Create/StartMoving.
// Idle animators and visible pieces are the rest state a freshly built unit
// already carries, so only the deviations are serialized.
func (u *Unit) ExportCob() frame.CobSnapshot {
	snap := frame.CobSnapshot{
		Static: append([]int32(nil), u.static...),
		NextID: u.nextID,
	}

	// Move and rotation animators share the piece*3+axis key space but live in
	// separate arrays; the rotation flag on the exported key distinguishes them
	// on import. Idle animators hold the rest pose a fresh unit already has, so
	// only active ones are emitted.
	appendAnims := func(arr []pieceAnim, rot bool) {
		for k := range arr {
			a := &arr[k]
			if a.kind == animIdle {
				continue
			}
			key := k
			if rot {
				key |= rotAnimFlag
			}
			snap.Anims = append(snap.Anims, frame.CobAnimSnap{
				Key:    key,
				Kind:   a.kind,
				Value:  int64(a.value),
				Target: int64(a.target),
				Speed:  int64(a.speed),
				Decel:  int64(a.decel),
				Done:   a.done,
			})
		}
	}
	appendAnims(u.moveAnims, false)
	appendAnims(u.rotAnims, true)

	for i, vis := range u.visible {
		if !vis {
			snap.Hidden = append(snap.Hidden, i)
		}
	}

	for _, t := range u.threads {
		if t.dead || t.queryOnly {
			continue
		}
		ts := frame.CobThreadSnap{
			ID:          t.id,
			ScriptIndex: t.scriptIndex,
			PC:          t.pc,
			Stack:       append([]int32(nil), t.stack...),
			Locals:      append([]int32(nil), t.locals...),
			SignalMask:  t.signalMask,
			SleepMs:     t.sleepMs,
			ReturnValue: t.returnValue,
		}
		if t.waitOn != nil {
			ts.Waiting = true
			ts.WaitRot = t.waitOn.rot
			ts.WaitKey = t.waitOn.key
		}
		for _, cf := range t.callStack {
			ts.CallStack = append(ts.CallStack, frame.CobCallFrame{
				ScriptIndex: cf.scriptIndex,
				PC:          cf.pc,
				Locals:      append([]int32(nil), cf.locals...),
			})
		}
		snap.Threads = append(snap.Threads, ts)
	}
	return snap
}

// rotAnimFlag tags an exported animator key as belonging to the rotation array.
// The real key space is piece*3+axis, far below this bit, so the flag is
// recoverable losslessly on import.
const rotAnimFlag = 1 << 30

// ImportCob overwrites the unit's live VM state with a previously exported
// snapshot, the inverse of ExportCob. The unit must already be built from the
// same program (so animator arrays are sized and scriptIndex values resolve);
// the caller rebuilds the unit via NewUnit, then applies this instead of
// running Create. Animators and visibility start from the freshly built rest
// state and are overwritten only where the snapshot deviates.
func (u *Unit) ImportCob(snap frame.CobSnapshot) {
	// Statics: copy what fits; a program mismatch only truncates rather than
	// panicking.
	for i := 0; i < len(snap.Static) && i < len(u.static); i++ {
		u.static[i] = snap.Static[i]
	}

	u.moveAnims = makeAnims(len(u.moveAnims))
	u.rotAnims = makeAnims(len(u.rotAnims))
	for _, a := range snap.Anims {
		key := a.Key
		arr := u.moveAnims
		if key&rotAnimFlag != 0 {
			key &^= rotAnimFlag
			arr = u.rotAnims
		}
		if key < 0 || key >= len(arr) {
			continue
		}
		arr[key] = pieceAnim{
			kind:   a.Kind,
			value:  fixed.Fixed(a.Value),
			target: fixed.Fixed(a.Target),
			speed:  fixed.Fixed(a.Speed),
			decel:  fixed.Fixed(a.Decel),
			done:   a.Done,
		}
	}

	for i := range u.visible {
		u.visible[i] = true
	}
	for _, p := range snap.Hidden {
		if p >= 0 && p < len(u.visible) {
			u.visible[p] = false
		}
	}

	u.threads = u.threads[:0]
	for _, ts := range snap.Threads {
		t := &thread{
			id:          ts.ID,
			scriptIndex: ts.ScriptIndex,
			pc:          ts.PC,
			stack:       append([]int32(nil), ts.Stack...),
			locals:      append([]int32(nil), ts.Locals...),
			signalMask:  ts.SignalMask,
			sleepMs:     ts.SleepMs,
			returnValue: ts.ReturnValue,
		}
		if ts.Waiting {
			t.waitOn = &waitCond{rot: ts.WaitRot, key: ts.WaitKey}
		}
		for _, cf := range ts.CallStack {
			t.callStack = append(t.callStack, callFrame{
				scriptIndex: cf.ScriptIndex,
				pc:          cf.PC,
				locals:      append([]int32(nil), cf.Locals...),
			})
		}
		u.threads = append(u.threads, t)
	}
	u.nextID = snap.NextID
}

// SnapshotRng returns the script RNG's internal state so a resync can hand the
// joiner the exact draw position the authority reached. OP_RAND consumes this
// stream, so matching it keeps script-driven randomness (and thus animation) in
// lockstep across the join.
func (r *Runtime) SnapshotRng() uint32 { return r.rng.Snapshot() }

// RestoreRng sets the script RNG's internal state, the inverse of SnapshotRng.
func (r *Runtime) RestoreRng(state uint32) { r.rng.Restore(state) }
