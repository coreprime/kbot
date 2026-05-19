package documentor

import (
	"fmt"
	"sort"
	"strings"
)

// CategoryGroup is one heading-level section: all units (or builders)
// that share a category, in display order.
type CategoryGroup struct {
	Key     CategoryKey
	Heading string // full heading text, e.g. "ARM — Commander"
	Anchor  string // GitHub-style slug for the heading
	Units   []Unit
}

// SideView is the view-model passed to the units template, one block
// per side.
type SideView struct {
	Side       string // "ARM" / "CORE" / "OTHER"
	Label      string // "Arm" / "Core" / "Other"
	SideAnchor string // GitHub-style anchor for the side heading
	Total      int
	Groups     []CategoryGroup // already sorted by Key.Sort
}

// UnitsView is the top-level view-model for ta-units.md.
type UnitsView struct {
	TotalUnits int
	Sides      []SideView
}

// BuildPage is one menu page of a builder's buildables.
type BuildPage struct {
	Page  int               // 1-indexed page number
	Slots map[int]BuildSlot // button (0..5) → slot
}

// BuilderView is one builder's worth of build pages.
type BuilderView struct {
	Builder       string
	Unit          Unit
	Pages         []BuildPage // sorted by Page
	Total         int
	DownloadCount int
}

// BuildTierGroup buckets builders by tier within a side.
type BuildTierGroup struct {
	Key      CategoryKey
	Heading  string // e.g. "Arm — Commander"
	Anchor   string // GitHub slug for the heading
	Builders []BuilderView
}

// BuildSideView is one side of the build-tree page.
type BuildSideView struct {
	Side       string
	Label      string
	SideAnchor string
	Total      int
	Tiers      []BuildTierGroup
}

// ReverseEntry is one buildable-unit row in the reverse index.
type ReverseEntry struct {
	Unit     Unit   // the buildable target
	Builders []Unit // resolved builder Unit records
}

// ReverseSideView groups reverse entries by side.
type ReverseSideView struct {
	Side    string
	Label   string
	Total   int
	Entries []ReverseEntry
}

// BuildTreeView is the top-level view-model for ta-buildtree.md.
type BuildTreeView struct {
	TotalBuilders int
	TotalPairs    int
	DownloadPairs int
	Sides         []BuildSideView
	Reverse       []ReverseSideView
	Unbuildable   []string // unit names that no builder reaches

	// UnitByKey lets slot-rendering helpers in the template resolve a
	// slot's UnitName to its display data without threading the map
	// through every nested call.
	UnitByKey map[string]Unit
}

// WeaponGroup is one heading-level group of weapons.
type WeaponGroup struct {
	Key     CategoryKey
	Weapons []Weapon
}

// WeaponUserMap is a reverse cross-reference: weapon key (upper) → unit names that use it.
type WeaponUserMap map[string][]string

// WeaponsView is the top-level view-model for ta-weapons.md.
type WeaponsView struct {
	TotalWeapons int
	UnitsWithWeapon int
	Groups          []WeaponGroup
	UserMap         WeaponUserMap     // key → sorted list of unit names
	UserKeys        []string          // sorted keys of UserMap
	Defined         map[string]bool   // weapon key → defined-here flag
}

// ----- Builders -----

// BuildUnitsView prepares the side-/category-grouped view-model for the units page.
func BuildUnitsView(ds *Dataset) UnitsView {
	categorise := UnitCategory
	if ds.Game == GameTAKingdoms {
		categorise = UnitCategoryTAK
	}
	bySide := map[string]map[string]CategoryGroup{}
	sideTotal := map[string]int{}
	for _, u := range ds.Units {
		side := u.Side
		if side == "" {
			side = "OTHER"
		}
		key := categorise(u)
		if _, ok := bySide[side]; !ok {
			bySide[side] = map[string]CategoryGroup{}
		}
		g := bySide[side][key.Sort]
		g.Key = key
		g.Units = append(g.Units, u)
		bySide[side][key.Sort] = g
		sideTotal[side]++
	}
	v := UnitsView{TotalUnits: len(ds.Units)}
	for _, side := range orderSidesForGame(bySide, ds.Game) {
		sv := SideView{
			Side:       side,
			Label:      sideLabelForGame(side, ds.Game),
			SideAnchor: tplAnchor(side),
			Total:      sideTotal[side],
		}
		var keys []string
		for k := range bySide[side] {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			g := bySide[side][k]
			sort.Slice(g.Units, func(i, j int) bool { return g.Units[i].UnitName < g.Units[j].UnitName })
			g.Heading = side + " — " + g.Key.Label
			g.Anchor = tplAnchor(g.Heading)
			sv.Groups = append(sv.Groups, g)
		}
		v.Sides = append(v.Sides, sv)
	}
	return v
}

// BuildBuildTreeView prepares the view-model for the build-tree page.
func BuildBuildTreeView(ds *Dataset) BuildTreeView {
	sideFn := SideOf
	tierFn := BuilderTier
	if ds.Game == GameTAKingdoms {
		sideFn = SideOfTAK
		tierFn = BuilderTierTAK
	}
	// Per-side / per-tier grouping of builders.
	bySideTier := map[string]map[string]*BuildTierGroup{}
	sideTotal := map[string]int{}
	totalPairs := 0
	downloadPairs := 0

	for builder, slots := range ds.Build.Slots {
		side := sideFn(builder)
		tierKey := tierFn(builder, ds.UnitByKey)
		if _, ok := bySideTier[side]; !ok {
			bySideTier[side] = map[string]*BuildTierGroup{}
		}
		grp, ok := bySideTier[side][tierKey.Sort]
		if !ok {
			grp = &BuildTierGroup{Key: tierKey}
			bySideTier[side][tierKey.Sort] = grp
		}

		// Build the per-page view for this builder.
		pageMap := map[int]map[int]BuildSlot{}
		dlCount := 0
		for _, s := range slots {
			if pageMap[s.Page] == nil {
				pageMap[s.Page] = map[int]BuildSlot{}
			}
			pageMap[s.Page][s.Button] = s
			if s.IsDownload() {
				dlCount++
			}
		}
		var pageNums []int
		for p := range pageMap {
			pageNums = append(pageNums, p)
		}
		sort.Ints(pageNums)
		var pages []BuildPage
		for _, p := range pageNums {
			pages = append(pages, BuildPage{Page: p, Slots: pageMap[p]})
		}
		bu := BuilderView{
			Builder:       builder,
			Unit:          ds.UnitByKey[builder],
			Pages:         pages,
			Total:         len(slots),
			DownloadCount: dlCount,
		}
		grp.Builders = append(grp.Builders, bu)
		sideTotal[side]++
		totalPairs += len(slots)
		downloadPairs += dlCount
	}

	v := BuildTreeView{
		TotalBuilders: len(ds.Build.Slots),
		TotalPairs:    totalPairs,
		DownloadPairs: downloadPairs,
		UnitByKey:     ds.UnitByKey,
	}
	for _, side := range orderSidesForGame(bySideTier, ds.Game) {
		sv := BuildSideView{
			Side: side, Label: sideLabelForGame(side, ds.Game), Total: sideTotal[side],
			SideAnchor: tplAnchor(side),
		}
		var keys []string
		for k := range bySideTier[side] {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			grp := bySideTier[side][k]
			sort.Slice(grp.Builders, func(i, j int) bool {
				return grp.Builders[i].Builder < grp.Builders[j].Builder
			})
			grp.Heading = sv.Label + " — " + grp.Key.Label
			grp.Anchor = tplAnchor(grp.Heading)
			sv.Tiers = append(sv.Tiers, *grp)
		}
		v.Sides = append(v.Sides, sv)
	}

	// Reverse index.
	reverse := map[string]map[string]bool{}
	for builder, slots := range ds.Build.Slots {
		for _, s := range slots {
			if reverse[s.Unit] == nil {
				reverse[s.Unit] = map[string]bool{}
			}
			reverse[s.Unit][builder] = true
		}
	}
	revBySide := map[string][]ReverseEntry{}
	built := map[string]bool{}
	for unit, bset := range reverse {
		built[unit] = true
		side := strings.ToUpper(ds.UnitByKey[unit].Side)
		if side == "" {
			side = SideOf(unit)
		}
		var bks []string
		for b := range bset {
			bks = append(bks, b)
		}
		sort.Strings(bks)
		var bs []Unit
		for _, b := range bks {
			bs = append(bs, ds.UnitByKey[b])
		}
		revBySide[side] = append(revBySide[side], ReverseEntry{
			Unit:     ds.UnitByKey[unit],
			Builders: bs,
		})
	}
	for _, sl := range revBySide {
		sort.Slice(sl, func(i, j int) bool { return sl[i].Unit.UnitName < sl[j].Unit.UnitName })
	}
	for _, side := range orderSidesForGame(revBySide, ds.Game) {
		entries := revBySide[side]
		if len(entries) == 0 {
			continue
		}
		v.Reverse = append(v.Reverse, ReverseSideView{
			Side: side, Label: sideLabelForGame(side, ds.Game), Total: len(entries), Entries: entries,
		})
	}

	// Unbuildable units (defined but not in any builder's list).
	all := map[string]bool{}
	for k := range ds.UnitByKey {
		all[k] = true
	}
	for k := range built {
		delete(all, k)
	}
	for k := range all {
		v.Unbuildable = append(v.Unbuildable, k)
	}
	sort.Strings(v.Unbuildable)

	return v
}

// BuildWeaponsView prepares the view-model for the weapons page.
func BuildWeaponsView(ds *Dataset) WeaponsView {
	v := WeaponsView{
		TotalWeapons: len(ds.Weapons),
		Defined:      map[string]bool{},
	}
	for _, w := range ds.Weapons {
		v.Defined[strings.ToUpper(w.NameKey)] = true
	}
	// Group by source file. TA: shared / per-unit / other; TA:K: by side
	// (since every weapon belongs to a unit and the only meaningful grouping
	// is the unit's side).
	groups := map[string]*WeaponGroup{}
	groupKey := func(w Weapon) CategoryKey {
		if ds.Game == GameTAKingdoms {
			side := SideOfTAK(w.Owner)
			return CategoryKey{Sort: sideSortKey(side, ds.Game), Label: TAKSideLabel(side) + " weapons"}
		}
		fn := strings.ToLower(w.File)
		switch {
		case fn == "weapons.tdf":
			return CategoryKey{"0", "Shared engine-defined weapons"}
		case strings.HasSuffix(fn, "_weapon.tdf"):
			return CategoryKey{"1", "Per-unit weapon definitions"}
		case strings.HasSuffix(fn, ".tdf"):
			return CategoryKey{"2", "Other weapon files"}
		}
		return CategoryKey{"9", "Misc"}
	}
	for _, w := range ds.Weapons {
		key := groupKey(w)
		g, ok := groups[key.Sort]
		if !ok {
			g = &WeaponGroup{Key: key}
			groups[key.Sort] = g
		}
		g.Weapons = append(g.Weapons, w)
	}
	var keys []string
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		g := groups[k]
		sort.Slice(g.Weapons, func(i, j int) bool {
			return strings.ToUpper(g.Weapons[i].NameKey) < strings.ToUpper(g.Weapons[j].NameKey)
		})
		v.Groups = append(v.Groups, *g)
	}

	v.UserMap = WeaponUserMap{}
	unitsWith := map[string]bool{}
	if ds.Game == GameTAKingdoms {
		// TA:K — weapon "names" collide across units, so flip the
		// cross-reference: owner → [WEAPONn — Display, …].
		for _, u := range ds.Units {
			if !u.HasWeapon() {
				continue
			}
			unitsWith[u.UnitName] = true
			for _, w := range u.InlineWeapons {
				label := w.NameKey
				if d := strings.TrimSpace(w.Display); d != "" {
					label = w.NameKey + " — " + d
				}
				v.UserMap[u.UnitName] = append(v.UserMap[u.UnitName], label)
			}
		}
	} else {
		for _, u := range ds.Units {
			for _, w := range u.Weapons() {
				v.UserMap[w] = append(v.UserMap[w], u.UnitName)
				unitsWith[u.UnitName] = true
			}
		}
		for k := range v.UserMap {
			sort.Strings(v.UserMap[k])
		}
	}
	for k := range v.UserMap {
		v.UserKeys = append(v.UserKeys, k)
	}
	sort.Strings(v.UserKeys)
	v.UnitsWithWeapon = len(unitsWith)
	return v
}

// sideSortKey returns a deterministic Sort key for a side, suitable for
// CategoryKey.Sort.
func sideSortKey(side string, g Game) string {
	order := orderSidesForGame(map[string]struct{}{side: {}}, g)
	if len(order) == 0 {
		return "9"
	}
	for i, s := range orderSidesForGame(allSidesMap(g), g) {
		if s == side {
			return fmt.Sprintf("%02d", i)
		}
	}
	return "9"
}

func allSidesMap(g Game) map[string]struct{} {
	switch g {
	case GameTAKingdoms:
		return map[string]struct{}{
			"ARA": {}, "TAR": {}, "VER": {}, "ZON": {}, "CRE": {},
			"MON": {}, "LIF": {}, "NPC": {}, "OTHER": {},
		}
	default:
		return map[string]struct{}{"ARM": {}, "CORE": {}, "OTHER": {}}
	}
}

// ----- helpers used in this file -----

// orderSidesForGame returns the side keys in a stable display order
// appropriate to the game. Unknown keys (mods, undefined sides) are
// appended alphabetically.
func orderSidesForGame[T any](m map[string]T, g Game) []string {
	var preferred []string
	switch g {
	case GameTAKingdoms:
		preferred = []string{"ARA", "TAR", "VER", "ZON", "CRE", "MON", "LIF", "NPC", "OTHER"}
	default:
		preferred = []string{"ARM", "CORE", "OTHER"}
	}
	out := make([]string, 0, len(m))
	seen := map[string]bool{}
	for _, s := range preferred {
		if _, ok := m[s]; ok {
			out = append(out, s)
			seen[s] = true
		}
	}
	var extras []string
	for s := range m {
		if !seen[s] {
			extras = append(extras, s)
		}
	}
	sort.Strings(extras)
	return append(out, extras...)
}

func sideLabelForGame(side string, g Game) string {
	if g == GameTAKingdoms {
		return TAKSideLabel(side)
	}
	switch side {
	case "ARM":
		return "Arm"
	case "CORE":
		return "Core"
	case "OTHER":
		return "Other"
	}
	return side
}
