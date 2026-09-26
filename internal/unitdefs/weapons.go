// Package unitdefs resolves unit, weapon and movement-class data the way TA
// 3.1c does, so the studio, packs and the game server all see the same
// weapon table, terrain limits and standing orders.
package unitdefs

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// WeaponFile is one weapons/*.tdf file: its path (used in warnings) and its
// bytes.
type WeaponFile struct {
	Path string
	Data []byte
}

// WeaponTable is the game's weapon table built from a set of weapons files:
// every weapon sits in the slot its ID names (0..255), and names resolve to
// the lowest slot holding a section of that name.
type WeaponTable struct {
	table *ta.WeaponTable
	// Warnings lists, in load order, the files the game refuses (their
	// weapons are left out), the sections it skips (no ID, an ID outside
	// 0..255), the sections a later one with the same ID replaces, and names
	// no unit can refer to.
	Warnings []string
}

// BuildWeaponTable loads files in order, the order the game lists them: a
// section goes into the slot its ID names, and a later section with the same
// ID, in the same file or a later one, replaces it. Each file is decoded on
// its own (see DecodeWeaponFile), so a problem in one file never drops the
// weapons of another. A path listed twice is loaded twice, as the game does;
// its warnings are reported once.
func BuildWeaponTable(files []WeaponFile) *WeaponTable {
	t := &WeaponTable{table: ta.NewWeaponTable()}
	seen := map[string]bool{}
	for _, f := range files {
		weapons, warns := DecodeWeaponFile(f.Data)
		mark := len(t.table.Warnings)
		t.table.Add(f.Path, weapons)
		if seen[strings.ToLower(f.Path)] {
			t.table.Warnings = t.table.Warnings[:mark]
			continue
		}
		seen[strings.ToLower(f.Path)] = true
		for _, w := range warns {
			t.Warnings = append(t.Warnings, f.Path+": "+w)
		}
		for _, w := range t.table.Warnings[mark:] {
			t.Warnings = append(t.Warnings, w.String())
		}
	}
	return t
}

// DecodeWeaponFile decodes one weapons file into its sections, in order, as
// the game reads it. Every value is read as a number prefix (13O is 13), so a
// bad value never drops a section. The game refuses the whole file for broken
// structure: a section header with no ']' or no '{', text with no '=' or a
// value with no ';' before the end of the file, the end of the file inside a
// section, or an empty file. Such a file (like one beyond the codec's size
// limits) adds no weapons, and the single warning says why.
func DecodeWeaponFile(data []byte) ([]ta.Weapon, []string) {
	var weapons []ta.Weapon
	err := tdf.UnmarshalWith(data, &weapons, tdf.ParseOptions{Strict: true})
	if err == nil {
		return weapons, nil
	}
	var se *tdf.SyntaxError
	if errors.As(err, &se) && se.Kind.Rejected() {
		return nil, []string{fmt.Sprintf("the game refuses the file (%s); none of its weapons load", se.Diagnostic)}
	}
	return nil, []string{fmt.Sprintf("%v; none of its weapons load", err)}
}

// Slots returns the table's weapons by slot (nil where no weapon has that ID).
func (t *WeaponTable) Slots() [ta.WeaponSlots]*ta.Weapon {
	return t.table.Slots
}

// ByID returns the weapon in slot id, or nil.
func (t *WeaponTable) ByID(id int) *ta.Weapon {
	return t.table.ByID(id)
}

// Find returns the weapon a unit's Weapon1 (Weapon2, Weapon3, ExplodeAs,
// SelfDestructAs) value names, and its slot: the lowest slot whose section
// name matches, ignoring case. It returns nil and -1 for an empty name or
// one no section has.
func (t *WeaponTable) Find(name string) (*ta.Weapon, int) {
	return t.table.Find(strings.TrimSpace(name))
}

// Resolve is Find returning the weapon with the game's defaults filled in (see
// ResolvedWeapon), in the shape the sim meta builders take as a resolver.
func (t *WeaponTable) Resolve(name string) (ta.Weapon, bool) {
	w, _ := t.Find(name)
	if w == nil {
		return ta.Weapon{}, false
	}
	return ResolvedWeapon(w), true
}

// Named returns every weapon a unit can refer to by name, in slot order: for
// each name, the weapon in the lowest slot holding it. Sections with no name
// are left out.
func (t *WeaponTable) Named() []*ta.Weapon {
	var out []*ta.Weapon
	seen := map[string]bool{}
	for _, w := range t.table.Slots {
		if w == nil || strings.TrimSpace(w.Key) == "" {
			continue
		}
		key := strings.ToUpper(w.Key)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, w)
	}
	return out
}

// ResolvedWeapon returns a copy of w with the values the game uses for keys
// its file leaves out: range 32767 and a minimum barrel angle of -11.25
// degrees. An explicit value, including 0, is kept.
func ResolvedWeapon(w *ta.Weapon) ta.Weapon {
	out := *w
	out.Range = w.EffectiveRange()
	out.MinBarrelAngle = w.EffectiveMinBarrelAngle()
	return out
}

// DamageTable returns a weapon's per-unit [DAMAGE] entries (every key but
// default), keyed by lower-case unit name, with each value kept to 16 bits as
// the game stores it; nil when there are none.
func DamageTable(w *ta.Weapon) map[string]int {
	var out map[string]int
	for k, v := range w.Damage {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" || k == "default" {
			continue
		}
		if out == nil {
			out = map[string]int{}
		}
		out[k] = int(int16(v))
	}
	return out
}

// ReloadTicks is a reload time in whole game ticks (30 per second), truncated
// as the game does: reloadtime=0.35 is 10 ticks, 0.333 seconds.
func ReloadTicks(seconds float64) int {
	return int(seconds * 30)
}

// SortLooseNames sorts file names the way the game enumerates loose files in
// a directory: by name with ASCII letters upper-cased.
func SortLooseNames(names []string) {
	sort.SliceStable(names, func(i, j int) bool {
		return upperASCII(names[i]) < upperASCII(names[j])
	})
}

func upperASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'a' <= c && c <= 'z' {
			b[i] = c - ('a' - 'A')
		}
	}
	return string(b)
}
