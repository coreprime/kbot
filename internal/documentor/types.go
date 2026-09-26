package documentor

// Unit is a parsed entry from a units/*.fbi file. Fields are populated
// best-effort — missing keys come back as empty strings or zero values.
//
// The struct mixes TA and TA:K fields; per-game extractors leave the
// inapplicable ones empty (e.g. TA has BuildMetal+BuildEnergy and no
// BuildCost; TA:K has BuildCost and no metal/energy split).
type Unit struct {
	File        string
	UnitName    string
	Side        string
	Name        string
	Description string
	Designation string
	Objectname  string
	Category    string
	TEDClass    string

	// TA dual-resource cost (empty on TA:K).
	BuildMetal  string
	BuildEnergy string
	// TA:K single-resource cost (empty on TA).
	BuildCost string

	BuildTime string
	MaxDamage string

	// TA-style weapon name refs (empty on TA:K which inlines weapons).
	Weapon1 string
	Weapon2 string
	Weapon3 string

	// TA:K inline weapons (empty on TA).
	InlineWeapons []Weapon

	IsFeature string
	Commander string

	// Builder is the FBI's Builder flag. TA gives a unit a [CANBUILD] list,
	// and download entries, only when it is set.
	Builder bool
}

// Weapons returns the non-empty weapon refs for the unit, in order.
// For TA the result is the FBI's Weapon1/2/3 ref strings; for TA:K it's
// the inline [WEAPONn] section names (which are unique per FBI).
func (u Unit) Weapons() []string {
	if len(u.InlineWeapons) > 0 {
		out := make([]string, 0, len(u.InlineWeapons))
		for _, w := range u.InlineWeapons {
			label := w.Display
			if label == "" {
				label = w.NameKey
			}
			out = append(out, label)
		}
		return out
	}
	out := make([]string, 0, 3)
	for _, w := range []string{u.Weapon1, u.Weapon2, u.Weapon3} {
		if w != "" {
			out = append(out, w)
		}
	}
	return out
}

// HasWeapon reports whether the unit declares at least one weapon.
func (u Unit) HasWeapon() bool { return len(u.Weapons()) > 0 }

// Weapon is a parsed entry from a weapons/*.tdf section (TA) or from a
// unit FBI's inline [WEAPONn] sub-section (TA:K).
type Weapon struct {
	File          string // source filename
	NameKey       string // [SECTION_NAME] — the key units refer to (TA) or "[WEAPONn]" (TA:K)
	Display       string // "name=" field
	ID            string
	Range         string
	Reload        string
	Velocity      string
	AOE           string
	DefaultDamage string
	Archetypes    []string // ballistic, lineofsight, … (TA); or just "type=" (TA:K)
	RenderType    string

	// Owner is the UnitName whose FBI carries this weapon as an inline
	// sub-section. Empty for TA weapons (which live in their own TDFs).
	Owner string
}

// ArchetypeString returns archetypes joined with ", " or "—".
func (w Weapon) ArchetypeString() string {
	if len(w.Archetypes) == 0 {
		return "—"
	}
	s := ""
	for i, a := range w.Archetypes {
		if i > 0 {
			s += ", "
		}
		s += a
	}
	return s
}

// MenuEntry is one [MENUENTRY] section from a download/*.tdf.
type MenuEntry struct {
	Builder string // UNITMENU=
	Menu    int    // MENU= (1-indexed page)
	Button  int    // BUTTON= (0..5)
	Unit    string // UNITNAME=
	Source  string // basename of the file the entry came from
}

// BuildSlot is the resolved page/button position for one unit registered
// against one builder. Source is "sidedata" or a download filename.
type BuildSlot struct {
	Page   int // 1-indexed
	Button int // 0..5
	Unit   string
	Source string
}

// IsDownload reports whether this slot came from a download/*.tdf.
func (s BuildSlot) IsDownload() bool { return s.Source != "sidedata" }

// BuildData groups every parsed (builder → slots) relationship.
type BuildData struct {
	// CanBuild maps a builder's UnitName → the raw ordered list of
	// canbuild units from sidedata.tdf (unannotated).
	CanBuild map[string][]string

	// MenuEntries is the flat list of every [MENUENTRY] across every
	// download/*.tdf, preserving the source filename for tracing.
	MenuEntries []MenuEntry

	// Slots is the merged builder → slot list (page/button derived).
	Slots map[string][]BuildSlot

	// Notes lists the entries the game leaves out of the build menus
	// (lists for units without Builder=1, entries after a gap or past the
	// limits, download entries naming no unit). Empty for retail data.
	Notes []string
}

// Dataset is everything one regeneration run needs to render.
type Dataset struct {
	Game      Game
	Units     []Unit
	UnitByKey map[string]Unit // keyed by uppercased UnitName

	Weapons     []Weapon
	WeaponByKey map[string]Weapon // keyed by uppercased NameKey

	// WeaponRefs maps each Weapon1/2/3 value a unit cites (upper-cased) to
	// the upper-cased key of the weapon the game resolves it to (TA only;
	// nil for TA:K, whose weapons are inline). A cited name missing from
	// the map matches no weapon.
	WeaponRefs map[string]string
	// WeaponNotes lists the weapon sections the game does not load or
	// replaces (no ID, an ID outside 0..255, a duplicate ID). Empty for
	// retail data.
	WeaponNotes []string

	Build BuildData
}
