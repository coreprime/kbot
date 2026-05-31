// Package crt decodes Total Annihilation: Kingdoms .crt scenario files.
//
// A .crt file accompanies a TA:K map (.tnt) and stores the scripted layer of a
// scenario: the pre-placed units/objects, the per-player rule engine (each rule
// a set of conditions guarding a set of actions) and the named rectangular
// trigger regions referenced by those rules. Multiplayer maps ship an empty
// stub (no units, nine empty players, no triggers); the campaign and special
// maps populate every section.
//
// The layout is a direct image of the in-memory C structures, so each unit
// record carries a fixed 256-byte type and name field followed by a block of
// 32-bit fields, several of which are uninitialised padding in shipped files.
package crt

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Signature is the little-endian uint32 that opens every .crt file. It is the
// IEEE-754 encoding of the float 1.0, used by the engine as a format marker.
const Signature uint32 = 0x3F800000

// unitRecordSize is the on-disk size of a single placed-unit record:
// two 256-byte strings plus fourteen uint32 fields.
const unitRecordSize = 256 + 256 + 14*4

const stringField = 256

// argsPerClause is the fixed number of 64-byte argument slots carried by every
// condition and action.
const argsPerClause = 5

const argSize = 64

// Unit is a single pre-placed unit or object.
type Unit struct {
	// Type is the unit/object definition name (e.g. "VERLIEGE", "NPCFARM").
	Type string
	// Name is the per-instance scripting handle; usually empty.
	Name string
	// X, Y, Z are the world position. Y is the vertical (height) axis.
	X, Y, Z uint32
	// Player is the owning player slot (0-based).
	Player uint32
	// HealthPercent, ArmorPercent, WeaponPercent are starting condition,
	// normally 100.
	HealthPercent, ArmorPercent, WeaponPercent uint32
	// Angle is the facing, in the engine's angle units.
	Angle uint32
	// Veteran is the starting veterancy level.
	Veteran uint32
	// FootprintX, FootprintZ are the unit's footprint in map cells.
	FootprintX, FootprintZ uint32
	// Unknown1..3 are undecoded fields, retained for round-trip fidelity.
	Unknown1, Unknown2, Unknown3 uint32
}

// Clause is a single condition or action: a numeric opcode followed by five
// fixed-size argument slots.
type Clause struct {
	// Opcode selects the condition or action to evaluate.
	Opcode uint32
	// Args holds the five raw 64-byte argument slots verbatim.
	Args [argsPerClause][argSize]byte
}

// Rule pairs a set of conditions with the actions they fire.
type Rule struct {
	Conditions []Clause
	Actions    []Clause
}

// Player is one scenario player slot and its rule list. Empty slots (the common
// case) carry no rules.
type Player struct {
	Rules []Rule
}

// Trigger is a named rectangular region referenced by rule conditions/actions.
type Trigger struct {
	Name                     string
	Left, Top, Right, Bottom uint32
}

// File is a decoded .crt scenario.
type File struct {
	// Unknown1 is the header word following the signature; 0 for every shipped
	// map except one hand-edited outlier.
	Unknown1 uint32
	Units    []Unit
	Players  []Player
	Triggers []Trigger
}

// reader is a bounds-checked little-endian cursor over the file bytes.
type reader struct {
	data []byte
	pos  int
}

func (r *reader) u32() (uint32, error) {
	if r.pos+4 > len(r.data) {
		return 0, io.ErrUnexpectedEOF
	}
	v := binary.LittleEndian.Uint32(r.data[r.pos:])
	r.pos += 4
	return v, nil
}

// str reads a fixed-width, NUL-terminated string field.
func (r *reader) str(width int) (string, error) {
	if r.pos+width > len(r.data) {
		return "", io.ErrUnexpectedEOF
	}
	b := r.data[r.pos : r.pos+width]
	r.pos += width
	if i := indexNUL(b); i >= 0 {
		b = b[:i]
	}
	return string(b), nil
}

func (r *reader) bytes(n int) ([]byte, error) {
	if r.pos+n > len(r.data) {
		return nil, io.ErrUnexpectedEOF
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	return b, nil
}

func indexNUL(b []byte) int {
	for i, c := range b {
		if c == 0 {
			return i
		}
	}
	return -1
}

// Load decodes a .crt file from raw bytes.
func Load(data []byte) (*File, error) {
	r := &reader{data: data}

	sig, err := r.u32()
	if err != nil {
		return nil, fmt.Errorf("read signature: %w", err)
	}
	if sig != Signature {
		return nil, fmt.Errorf("not a TA:K .crt file: signature 0x%08X, want 0x%08X", sig, Signature)
	}

	f := &File{}
	if f.Unknown1, err = r.u32(); err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	unitCount, err := r.u32()
	if err != nil {
		return nil, fmt.Errorf("read unit count: %w", err)
	}
	// Guard against the single hand-edited outlier whose header is shifted: a
	// plausible scenario never approaches this many records.
	if need := int64(unitCount) * unitRecordSize; need < 0 || r.pos+int(need) > len(data) {
		return nil, fmt.Errorf("unit count %d exceeds file bounds (%d bytes)", unitCount, len(data))
	}

	f.Units = make([]Unit, 0, unitCount)
	for i := uint32(0); i < unitCount; i++ {
		u, err := readUnit(r)
		if err != nil {
			return nil, fmt.Errorf("unit %d: %w", i, err)
		}
		f.Units = append(f.Units, u)
	}

	if err := readPlayers(r, f); err != nil {
		return nil, err
	}
	if err := readTriggers(r, f); err != nil {
		return nil, err
	}
	return f, nil
}

func readUnit(r *reader) (Unit, error) {
	var u Unit
	var err error
	if u.Type, err = r.str(stringField); err != nil {
		return u, err
	}
	if u.Name, err = r.str(stringField); err != nil {
		return u, err
	}
	fields := []*uint32{
		&u.X, &u.Y, &u.Z, &u.Player,
		&u.HealthPercent, &u.ArmorPercent, &u.WeaponPercent,
		&u.Angle, &u.Veteran, &u.Unknown1, &u.Unknown2,
		&u.FootprintX, &u.FootprintZ, &u.Unknown3,
	}
	for _, p := range fields {
		if *p, err = r.u32(); err != nil {
			return u, err
		}
	}
	return u, nil
}

func readPlayers(r *reader, f *File) error {
	count, err := r.u32()
	if err != nil {
		return fmt.Errorf("read player count: %w", err)
	}
	f.Players = make([]Player, 0, count)
	for i := uint32(0); i < count; i++ {
		p, err := readPlayer(r)
		if err != nil {
			return fmt.Errorf("player %d: %w", i, err)
		}
		f.Players = append(f.Players, p)
	}
	return nil
}

func readPlayer(r *reader) (Player, error) {
	var p Player
	ruleCount, err := r.u32()
	if err != nil {
		return p, err
	}
	p.Rules = make([]Rule, 0, ruleCount)
	for i := uint32(0); i < ruleCount; i++ {
		rule, err := readRule(r)
		if err != nil {
			return p, fmt.Errorf("rule %d: %w", i, err)
		}
		p.Rules = append(p.Rules, rule)
	}
	return p, nil
}

func readRule(r *reader) (Rule, error) {
	var rule Rule
	conditions, err := readClauses(r)
	if err != nil {
		return rule, fmt.Errorf("conditions: %w", err)
	}
	rule.Conditions = conditions
	actions, err := readClauses(r)
	if err != nil {
		return rule, fmt.Errorf("actions: %w", err)
	}
	rule.Actions = actions
	return rule, nil
}

func readClauses(r *reader) ([]Clause, error) {
	count, err := r.u32()
	if err != nil {
		return nil, err
	}
	clauses := make([]Clause, 0, count)
	for i := uint32(0); i < count; i++ {
		var c Clause
		if c.Opcode, err = r.u32(); err != nil {
			return nil, err
		}
		for a := 0; a < argsPerClause; a++ {
			b, err := r.bytes(argSize)
			if err != nil {
				return nil, err
			}
			copy(c.Args[a][:], b)
		}
		clauses = append(clauses, c)
	}
	return clauses, nil
}

func readTriggers(r *reader, f *File) error {
	count, err := r.u32()
	if err != nil {
		return fmt.Errorf("read trigger count: %w", err)
	}
	f.Triggers = make([]Trigger, 0, count)
	for i := uint32(0); i < count; i++ {
		var t Trigger
		if t.Name, err = r.str(stringField); err != nil {
			return fmt.Errorf("trigger %d name: %w", i, err)
		}
		for _, p := range []*uint32{&t.Left, &t.Top, &t.Right, &t.Bottom} {
			if *p, err = r.u32(); err != nil {
				return fmt.Errorf("trigger %d bounds: %w", i, err)
			}
		}
		f.Triggers = append(f.Triggers, t)
	}
	return nil
}

// UnitCounts returns the number of placements per unit type.
func (f *File) UnitCounts() map[string]int {
	counts := make(map[string]int)
	for _, u := range f.Units {
		counts[u.Type]++
	}
	return counts
}

// RuleCount returns the total number of rules across all players.
func (f *File) RuleCount() int {
	n := 0
	for _, p := range f.Players {
		n += len(p.Rules)
	}
	return n
}
