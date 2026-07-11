package documentor

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot-io/formats/tdf"
)

// extractUnitsTAK parses every .fbi under units/ in a flattened TA: Kingdoms
// install. Each FBI carries its weapons inline as `[WEAPON1]`, `[WEAPON2]`,
// … sub-sections of `[UNITINFO]`, so we also harvest those into ds.Weapons.
func extractUnitsTAK(flatRoot string, ds *Dataset) error {
	dir := filepath.Join(flatRoot, "units")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, ent := range entries {
		if ent.IsDir() || !strings.EqualFold(filepath.Ext(ent.Name()), ".fbi") {
			continue
		}
		doc, err := tdf.ParseFile(filepath.Join(dir, ent.Name()))
		if err != nil {
			continue
		}
		// TA:K FBIs sometimes have peer sections ([UNITINFO], [WEAPON1]) at
		// the root rather than nested under [UNITINFO]; accept either shape.
		info := firstSection(doc, "UNITINFO")
		if info == nil {
			continue
		}
		u := Unit{
			File:        ent.Name(),
			UnitName:    info.String("unitname"),
			Side:        strings.ToUpper(info.String("side")),
			Name:        info.String("name"),
			Description: info.String("description"),
			Designation: info.String("designation"),
			Objectname:  info.String("objectname"),
			Category:    info.String("category"),
			TEDClass:    info.String("tedclass"),
			BuildCost:   info.String("buildcost"),
			BuildTime:   info.String("buildtime"),
			MaxDamage:   info.String("maxdamage"),
			IsFeature:   info.String("isfeature"),
			Commander:   info.String("commander"),
		}
		if u.Name == "" {
			u.Name = u.Designation
		}
		// Pull inline weapon sub-sections.
		u.InlineWeapons = takInlineWeapons(doc, info, u.UnitName)
		ds.Units = append(ds.Units, u)
		if k := strings.ToUpper(u.UnitName); k != "" {
			ds.UnitByKey[k] = u
		}
		for _, w := range u.InlineWeapons {
			ds.Weapons = append(ds.Weapons, w)
			ds.WeaponByKey[strings.ToUpper(w.NameKey)] = w
		}
	}
	sort.Slice(ds.Units, func(i, j int) bool { return ds.Units[i].UnitName < ds.Units[j].UnitName })
	sort.Slice(ds.Weapons, func(i, j int) bool {
		if ds.Weapons[i].Owner != ds.Weapons[j].Owner {
			return ds.Weapons[i].Owner < ds.Weapons[j].Owner
		}
		return ds.Weapons[i].NameKey < ds.Weapons[j].NameKey
	})
	return nil
}

// takInlineWeapons collects every [WEAPONn] subsection of the root [UNITINFO]
// (or sibling at the document root, since TA:K FBIs are inconsistent on
// nesting) and returns them as Weapon records owned by the given unit.
func takInlineWeapons(doc *tdf.Document, info *tdf.Section, owner string) []Weapon {
	var out []Weapon

	collect := func(sec *tdf.Section) {
		name := strings.ToUpper(sec.Name())
		if !strings.HasPrefix(name, "WEAPON") {
			return
		}
		w := Weapon{
			NameKey:    sec.Name(),
			Display:    strings.TrimSpace(sec.String("name")),
			ID:         trimSemi(sec.String("id")),
			Range:      trimSemi(sec.String("range")),
			Reload:     trimSemi(sec.String("reloadtime")),
			Velocity:   trimSemi(sec.String("weaponvelocity")),
			AOE:        trimSemi(sec.String("areaofeffect")),
			RenderType: trimSemi(sec.String("rendertype")),
			Owner:      strings.ToUpper(owner),
			File:       strings.ToLower(owner) + ".fbi",
		}
		// The TA:K "archetype" is a single `type=` field rather than the TA
		// bag of boolean flags.
		if t := strings.TrimSpace(trimSemi(sec.String("type"))); t != "" {
			w.Archetypes = []string{strings.ToLower(t)}
		}
		// Damage default lives in [DAMAGE].default under the weapon.
		for _, sub := range sec.Sections() {
			if strings.EqualFold(sub.Name(), "DAMAGE") {
				w.DefaultDamage = trimSemi(sub.String("default"))
			}
		}
		out = append(out, w)
	}

	for _, sub := range info.Sections() {
		collect(sub)
	}
	for _, sib := range doc.Sections() {
		if strings.EqualFold(sib.Name(), "UNITINFO") {
			continue
		}
		collect(sib)
	}
	return out
}

// extractBuildDataTAK walks canbuild/<builder>/<unit>.tdf and turns each
// (builder, unit, Priority) tuple into a BuildSlot.
func extractBuildDataTAK(flatRoot string, ds *Dataset) error {
	root := filepath.Join(flatRoot, "canbuild")
	builders, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	type entry struct {
		unit     string
		priority int
		source   string
	}
	for _, b := range builders {
		if !b.IsDir() {
			continue
		}
		builder := strings.ToUpper(b.Name())
		files, err := os.ReadDir(filepath.Join(root, b.Name()))
		if err != nil {
			continue
		}
		var ents []entry
		for _, f := range files {
			if f.IsDir() || !strings.EqualFold(filepath.Ext(f.Name()), ".tdf") {
				continue
			}
			unitName := strings.ToUpper(strings.TrimSuffix(f.Name(), filepath.Ext(f.Name())))
			doc, err := tdf.ParseFile(filepath.Join(root, b.Name(), f.Name()))
			if err != nil {
				continue
			}
			menu := firstSection(doc, "MENU", "Menu")
			pri := 0
			if menu != nil {
				if v, err := strconv.Atoi(strings.TrimSpace(trimSemi(menu.String("Priority")))); err == nil {
					pri = v
				}
			}
			ents = append(ents, entry{unit: unitName, priority: pri, source: f.Name()})
		}
		// Sort by priority ascending, then alphabetically as a tiebreaker.
		sort.Slice(ents, func(i, j int) bool {
			if ents[i].priority != ents[j].priority {
				return ents[i].priority < ents[j].priority
			}
			return ents[i].unit < ents[j].unit
		})
		// Materialise as BuildSlots and CanBuild map.
		for _, e := range ents {
			ds.Build.CanBuild[builder] = append(ds.Build.CanBuild[builder], e.unit)
			ds.Build.Slots[builder] = append(ds.Build.Slots[builder], BuildSlot{
				Page:   1,
				Button: e.priority,
				Unit:   e.unit,
				Source: "canbuild",
			})
		}
	}
	if len(ds.Build.Slots) == 0 {
		return fmt.Errorf("no canbuild/*/*.tdf entries found under %s", root)
	}
	return nil
}
