package documentor

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot-io/formats/gamedata/common"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// SlotsPerPage is TA's per-page build-menu grid (2 columns × 3 rows).
// TA: Kingdoms does not use this grid concept — its canbuild/*.tdf
// files carry a linear Priority instead.
const SlotsPerPage = 6

// Extract walks a flattened install of the given game and returns the
// populated dataset. flatRoot is expected to be the root of a flattened
// install (the same shape kbot mount --flatten produces).
func Extract(flatRoot string, game Game) (*Dataset, error) {
	if flatRoot == "" {
		return nil, fmt.Errorf("flatRoot is required")
	}
	st, err := os.Stat(flatRoot)
	if err != nil {
		return nil, fmt.Errorf("stat %s: %w", flatRoot, err)
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", flatRoot)
	}

	ds := &Dataset{
		Game:        game,
		UnitByKey:   make(map[string]Unit),
		WeaponByKey: make(map[string]Weapon),
		Build: BuildData{
			CanBuild: make(map[string][]string),
			Slots:    make(map[string][]BuildSlot),
		},
	}

	switch game {
	case GameTAKingdoms:
		if err := extractUnitsTAK(flatRoot, ds); err != nil {
			return nil, fmt.Errorf("units: %w", err)
		}
		if err := extractBuildDataTAK(flatRoot, ds); err != nil {
			return nil, fmt.Errorf("build data: %w", err)
		}
	default: // totala
		if err := extractUnits(flatRoot, ds); err != nil {
			return nil, fmt.Errorf("units: %w", err)
		}
		if err := extractWeapons(flatRoot, ds); err != nil {
			return nil, fmt.Errorf("weapons: %w", err)
		}
		if err := extractBuildData(flatRoot, ds); err != nil {
			return nil, fmt.Errorf("build data: %w", err)
		}
		buildSlots(ds)
	}
	return ds, nil
}

// gameOrderFiles lists the files in dir whose extension is ext (ignoring
// case) in the order the game enumerates loose files: by name with ASCII
// letters upper-cased. A missing directory lists nothing.
func gameOrderFiles(dir, ext string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var files []string
	for _, ent := range entries {
		if !ent.IsDir() && strings.EqualFold(filepath.Ext(ent.Name()), ext) {
			files = append(files, ent.Name())
		}
	}
	sort.Slice(files, func(i, j int) bool { return strings.ToUpper(files[i]) < strings.ToUpper(files[j]) })
	return files, nil
}

// catchAll returns the value of key (ignoring case) from a decoded section's
// catch-all map.
func catchAll(m map[string]string, key string) string {
	for k, v := range m {
		if strings.EqualFold(k, key) {
			return v
		}
	}
	return ""
}

// extractUnits decodes every units/*.fbi with the tdf codec, reading the
// [UNITINFO] section as the game does: a value runs to the next ';', comments
// are blanked, and numbers are read as their numeric prefix. A file without
// a UnitName is skipped; when two files name the same unit the first, in the
// game's listing order, is the one lookups find.
func extractUnits(flatRoot string, ds *Dataset) error {
	dir := filepath.Join(flatRoot, "units")
	files, err := gameOrderFiles(dir, ".fbi")
	if err != nil {
		return err
	}
	for _, fn := range files {
		data, err := os.ReadFile(filepath.Join(dir, fn))
		if err != nil {
			return err
		}
		var fbi ta.Unit
		if err := tdf.Unmarshal(data, &fbi); err != nil {
			// Skip malformed FBIs rather than fail the whole run; mods sometimes ship broken files.
			continue
		}
		info := &fbi.Info
		if info.UnitName == "" {
			continue
		}
		present := func(key string) bool { return info.Meta.Present(key) }
		u := Unit{
			File:        fn,
			UnitName:    info.UnitName,
			Side:        strings.ToUpper(info.Side),
			Name:        info.Name,
			Description: info.Description,
			Designation: info.Designation,
			Objectname:  info.ObjectName,
			Category:    strings.Join(info.Category, " "),
			TEDClass:    info.TEDClass,
			Weapon1:     strings.ToUpper(strings.TrimSpace(info.Weapon1)),
			Weapon2:     strings.ToUpper(strings.TrimSpace(info.Weapon2)),
			Weapon3:     strings.ToUpper(strings.TrimSpace(info.Weapon3)),
			IsFeature:   catchAll(info.Remaining, "isfeature"),
			Builder:     info.Builder != 0,
		}
		if present("buildcostmetal") {
			u.BuildMetal = strconv.Itoa(info.EffectiveBuildCostMetal())
		}
		if present("buildcostenergy") {
			u.BuildEnergy = strconv.Itoa(info.EffectiveBuildCostEnergy())
		}
		if present("maxdamage") {
			u.MaxDamage = strconv.Itoa(info.MaxDamage)
		}
		if present("commander") {
			u.Commander = strconv.Itoa(info.Commander)
		}
		if u.Name == "" {
			u.Name = u.Designation
		}
		k := strings.ToUpper(u.UnitName)
		if _, dup := ds.UnitByKey[k]; dup {
			continue
		}
		ds.Units = append(ds.Units, u)
		ds.UnitByKey[k] = u
	}
	sort.Slice(ds.Units, func(i, j int) bool { return ds.Units[i].UnitName < ds.Units[j].UnitName })
	return nil
}

// extractWeapons builds the game's weapon table: the sections of every .tdf
// directly in weapons/ (gamedata/weapons.tdf is not a weapon source), read
// file by file in listing order and placed in the slot their ID names. A
// section with no usable ID is not loaded and a later section with the same
// ID replaces an earlier one; both are recorded in ds.WeaponNotes. Each
// unit's Weapon1/2/3 is then resolved through the table the way the game
// resolves it (the lowest slot whose name matches, ignoring case), into
// ds.WeaponRefs.
func extractWeapons(flatRoot string, ds *Dataset) error {
	dir := filepath.Join(flatRoot, "weapons")
	files, err := gameOrderFiles(dir, ".tdf")
	if err != nil {
		return err
	}
	table := ta.NewWeaponTable()
	for _, fn := range files {
		if !ta.IsWeaponFile("weapons/" + fn) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, fn))
		if err != nil {
			return err
		}
		var weapons []ta.Weapon
		if err := tdf.Unmarshal(data, &weapons); err != nil {
			ds.WeaponNotes = append(ds.WeaponNotes, fmt.Sprintf("%s: %v", fn, err))
			continue
		}
		table.Add(fn, weapons)
	}
	for _, w := range table.Warnings {
		ds.WeaponNotes = append(ds.WeaponNotes, w.String())
	}

	for id, tw := range table.Slots {
		if tw == nil {
			continue
		}
		w := weaponRow(tw, id, table.Files[id])
		ds.Weapons = append(ds.Weapons, w)
		if key := strings.ToUpper(w.NameKey); key != "" {
			if _, dup := ds.WeaponByKey[key]; !dup {
				ds.WeaponByKey[key] = w
			}
		}
	}

	ds.WeaponRefs = map[string]string{}
	for _, u := range ds.Units {
		for _, ref := range u.Weapons() {
			if tw, _ := table.Find(ref); tw != nil {
				ds.WeaponRefs[ref] = strings.ToUpper(tw.Key)
			}
		}
	}
	return nil
}

var archetypeFlags = []string{
	"ballistic", "lineofsight", "dropped", "beamweapon", "guidance",
	"selfprop", "twophase", "burnblow", "waterweapon", "noexplode",
}

// weaponRow turns one slot of the game's weapon table into a catalogue row,
// showing the values the game uses (a weapon with no range key has range
// 32767).
func weaponRow(tw *ta.Weapon, id int, file string) Weapon {
	present := func(key string) bool { return tw.Meta.Present(key) }
	num := func(key string, v float64) string {
		if !present(key) {
			return ""
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	w := Weapon{
		File:     file,
		NameKey:  tw.Key,
		Display:  tw.Name,
		ID:       strconv.Itoa(id),
		Range:    strconv.Itoa(tw.EffectiveRange()),
		Reload:   num("reloadtime", tw.ReloadTime),
		Velocity: num("weaponvelocity", tw.WeaponVelocity),
		AOE:      num("areaofeffect", float64(tw.AreaOfEffect)),
	}
	if present("rendertype") {
		w.RenderType = strconv.Itoa(tw.RenderType)
	}
	for k := range tw.Damage {
		if strings.EqualFold(k, "default") {
			w.DefaultDamage = strconv.Itoa(tw.EffectiveDamage(""))
		}
	}
	flags := map[string]int{
		"ballistic": tw.Ballistic, "lineofsight": tw.LineOfSight, "dropped": tw.Dropped,
		"beamweapon": tw.BeamWeapon, "guidance": tw.Guidance, "selfprop": tw.SelfProp,
		"twophase": tw.TwoPhase, "burnblow": tw.BurnBlow, "waterweapon": tw.WaterWeapon,
		"noexplode": tw.NoExplode,
	}
	for _, flag := range archetypeFlags {
		if flags[flag] != 0 {
			w.Archetypes = append(w.Archetypes, flag)
		}
	}
	return w
}

// extractBuildData reads the build menus the way the game assembles them.
//
// The first [CANBUILD] section of gamedata/sidedata.tdf gives each unit with
// Builder=1 its list: canbuild1, canbuild2, ... up to the first missing key,
// names that match no unit skipped, at most 30 (CanBuildBuilder.BuildList).
// Each download/*.tdf then adds entries from its first five sections,
// whatever their names (DownloadFile.Menus): an entry counts when its
// UNITMENU names a builder and its UNITNAME a unit, and a builder's list
// holds at most 31 units in all. What the game leaves out is recorded in
// ds.Build.Notes.
func extractBuildData(flatRoot string, ds *Dataset) error {
	known := func(name string) bool {
		_, ok := ds.UnitByKey[strings.ToUpper(name)]
		return ok
	}
	isBuilder := map[string]bool{}
	for _, u := range ds.Units {
		if u.Builder {
			isBuilder[strings.ToUpper(u.UnitName)] = true
		}
	}
	count := map[string]int{}

	sidePath := filepath.Join(flatRoot, "gamedata", "sidedata.tdf")
	if data, err := os.ReadFile(sidePath); err == nil {
		var sd ta.SideData
		if err := tdf.Unmarshal(data, &sd); err != nil {
			ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf("gamedata/sidedata.tdf: %v", err))
		} else {
			for _, u := range ds.Units {
				b := sd.CanBuild.Builder(u.UnitName)
				if b == nil {
					continue
				}
				name := strings.ToUpper(u.UnitName)
				if !u.Builder {
					ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
						"[CANBUILD/%s] %s has no Builder=1; the game reads no list for it", b.Name, name))
					continue
				}
				units := []string{}
				listed := func(v string) bool {
					if known(v) {
						return true
					}
					ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
						"[CANBUILD/%s] %s names no unit; the game skips it", b.Name, v))
					return false
				}
				for _, v := range b.BuildList(listed) {
					units = append(units, strings.ToUpper(v))
				}
				ds.Build.CanBuild[name] = units
				count[name] = len(units)
			}
			for _, w := range sd.Check() {
				if strings.HasPrefix(strings.ToUpper(w.Section), "CANBUILD") {
					ds.Build.Notes = append(ds.Build.Notes, w.String())
				}
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	dir := filepath.Join(flatRoot, "download")
	files, err := gameOrderFiles(dir, ".tdf")
	if err != nil {
		return err
	}
	for _, fn := range files {
		data, err := os.ReadFile(filepath.Join(dir, fn))
		if err != nil {
			return err
		}
		var df common.DownloadFile
		if err := tdf.Unmarshal(data, &df); err != nil {
			ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf("download/%s: %v", fn, err))
			continue
		}
		if extra := len(df.Entries) - common.DownloadMenuLimit; extra > 0 {
			ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
				"download/%s: %d section%s after the first %d; the game reads only the first %d",
				fn, extra, plural(extra), common.DownloadMenuLimit, common.DownloadMenuLimit))
		}
		for _, e := range df.Menus() {
			builder := strings.ToUpper(e.UnitMenu)
			unit := strings.ToUpper(e.UnitName)
			switch {
			case !known(builder):
				ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
					"download/%s [%s]: UNITMENU %q names no unit; the game ignores the entry", fn, e.Key, e.UnitMenu))
				continue
			case !known(unit):
				ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
					"download/%s [%s]: UNITNAME %q names no unit; the game adds nothing", fn, e.Key, e.UnitName))
				continue
			case !isBuilder[builder]:
				ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
					"download/%s [%s]: %s has no Builder=1, so it has no build list to add %s to", fn, e.Key, builder, unit))
				continue
			case count[builder] >= common.BuildListLimit:
				ds.Build.Notes = append(ds.Build.Notes, fmt.Sprintf(
					"download/%s [%s]: %s's build list already holds %d units; the game drops %s",
					fn, e.Key, builder, common.BuildListLimit, unit))
				continue
			}
			count[builder]++
			ds.Build.MenuEntries = append(ds.Build.MenuEntries, MenuEntry{
				Builder: builder,
				Menu:    int(uint8(e.Menu)),
				Button:  int(uint8(e.Button)),
				Unit:    unit,
				Source:  fn,
			})
		}
	}
	return nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// buildSlots merges CanBuild + MenuEntries into ds.Build.Slots: a CANBUILD
// entry's position follows from its index in the list, a download entry
// sits on its MENU page at its BUTTON.
func buildSlots(ds *Dataset) {
	for builder, units := range ds.Build.CanBuild {
		for i, unit := range units {
			ds.Build.Slots[builder] = append(ds.Build.Slots[builder], BuildSlot{
				Page:   i/SlotsPerPage + 1,
				Button: i % SlotsPerPage,
				Unit:   unit,
				Source: "sidedata",
			})
		}
	}
	for _, e := range ds.Build.MenuEntries {
		// Skip if same builder already has this unit (defensive: some mods duplicate).
		dup := false
		for _, existing := range ds.Build.Slots[e.Builder] {
			if existing.Unit == e.Unit {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		ds.Build.Slots[e.Builder] = append(ds.Build.Slots[e.Builder], BuildSlot{
			Page:   e.Menu,
			Button: e.Button,
			Unit:   e.Unit,
			Source: e.Source,
		})
	}
}

// firstSection returns the first section matching one of the names (case-insensitive),
// falling back to the first root section if no name matches.
func firstSection(doc *tdf.Document, names ...string) *tdf.Section {
	for _, n := range names {
		if sec := doc.Section(n); sec != nil {
			return sec
		}
	}
	secs := doc.Sections()
	if len(secs) > 0 {
		return secs[0]
	}
	return nil
}

func trimSemi(s string) string { return strings.TrimRight(strings.TrimSpace(s), ";") }
