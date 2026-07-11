package documentor

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

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

// extractUnits parses every .fbi under units/ in the install.
func extractUnits(flatRoot string, ds *Dataset) error {
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
			// Skip malformed FBIs rather than fail the whole run; mods sometimes ship broken files.
			continue
		}
		info := firstSection(doc, "UNITINFO")
		if info == nil {
			continue
		}
		u := Unit{
			File:        ent.Name(),
			UnitName:    info.String("UnitName"),
			Side:        strings.ToUpper(info.String("Side")),
			Name:        info.String("Name"),
			Description: info.String("Description"),
			Designation: info.String("Designation"),
			Objectname:  info.String("Objectname"),
			Category:    info.String("Category"),
			TEDClass:    info.String("TEDClass"),
			BuildMetal:  info.String("BuildCostMetal"),
			BuildEnergy: info.String("BuildCostEnergy"),
			MaxDamage:   info.String("MaxDamage"),
			Weapon1:     strings.ToUpper(strings.TrimSpace(info.String("Weapon1"))),
			Weapon2:     strings.ToUpper(strings.TrimSpace(info.String("Weapon2"))),
			Weapon3:     strings.ToUpper(strings.TrimSpace(info.String("Weapon3"))),
			IsFeature:   info.String("IsFeature"),
			Commander:   info.String("Commander"),
		}
		if u.Name == "" {
			u.Name = u.Designation
		}
		ds.Units = append(ds.Units, u)
		if k := strings.ToUpper(u.UnitName); k != "" {
			ds.UnitByKey[k] = u
		}
	}
	sort.Slice(ds.Units, func(i, j int) bool { return ds.Units[i].UnitName < ds.Units[j].UnitName })
	return nil
}

var archetypeFlags = []string{
	"ballistic", "lineofsight", "dropped", "beamweapon", "guidance",
	"selfprop", "twophase", "burnblow", "waterweapon", "noexplode",
}

// extractWeapons parses every weapon TDF the engine would see.
func extractWeapons(flatRoot string, ds *Dataset) error {
	paths := []string{}
	wdir := filepath.Join(flatRoot, "weapons")
	if entries, err := os.ReadDir(wdir); err == nil {
		for _, ent := range entries {
			if ent.IsDir() || !strings.EqualFold(filepath.Ext(ent.Name()), ".tdf") {
				continue
			}
			paths = append(paths, filepath.Join(wdir, ent.Name()))
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	sort.Strings(paths)
	// gamedata/weapons.tdf is the engine's reference doc; treat as another source.
	if gw := filepath.Join(flatRoot, "gamedata", "weapons.tdf"); fileExists(gw) {
		paths = append(paths, gw)
	}
	seen := make(map[string]bool)
	for _, p := range paths {
		doc, err := tdf.ParseFile(p)
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			key := strings.ToUpper(strings.TrimSpace(sec.Name()))
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			w := Weapon{
				File:          filepath.Base(p),
				NameKey:       sec.Name(),
				Display:       sec.String("name"),
				ID:            trimSemi(sec.String("ID")),
				Range:         trimSemi(sec.String("range")),
				Reload:        trimSemi(sec.String("reloadtime")),
				Velocity:      trimSemi(sec.String("weaponvelocity")),
				AOE:           trimSemi(sec.String("areaofeffect")),
				DefaultDamage: damageDefault(sec),
				RenderType:    trimSemi(sec.String("rendertype")),
			}
			for _, flag := range archetypeFlags {
				if v := strings.TrimSpace(strings.TrimRight(sec.String(flag), ";")); v != "" && v != "0" {
					w.Archetypes = append(w.Archetypes, flag)
				}
			}
			ds.Weapons = append(ds.Weapons, w)
			ds.WeaponByKey[key] = w
		}
	}
	return nil
}

// damageDefault digs out [DAMAGE].default for a weapon, if present.
func damageDefault(sec *tdf.Section) string {
	for _, sub := range sec.Sections() {
		if strings.EqualFold(sub.Name(), "DAMAGE") {
			return trimSemi(sub.String("default"))
		}
	}
	return ""
}

// extractBuildData reads sidedata.tdf [CANBUILD] + every download/*.tdf [MENUENTRY].
func extractBuildData(flatRoot string, ds *Dataset) error {
	sidePath := filepath.Join(flatRoot, "gamedata", "sidedata.tdf")
	if fileExists(sidePath) {
		doc, err := tdf.ParseFile(sidePath)
		if err == nil {
			canbuild := doc.Section("CANBUILD")
			if canbuild != nil {
				for _, sub := range canbuild.Sections() {
					name := strings.ToUpper(sub.Name())
					units := []string{}
					// Iterate canbuild1..canbuildN in numeric order until a gap.
					for i := 1; ; i++ {
						key := fmt.Sprintf("canbuild%d", i)
						v := strings.ToUpper(strings.TrimSpace(sub.String(key)))
						if v == "" {
							// Allow gaps up to 50 (sometimes a builder skips a slot).
							gap := false
							for j := i + 1; j <= i+50; j++ {
								if w := strings.ToUpper(strings.TrimSpace(sub.String(fmt.Sprintf("canbuild%d", j)))); w != "" {
									gap = true
									break
								}
							}
							if !gap {
								break
							}
							i = nextSlotIndex(sub, i)
							continue
						}
						units = append(units, v)
					}
					ds.Build.CanBuild[name] = units
				}
			}
		}
	}

	downloads := filepath.Join(flatRoot, "download")
	if entries, err := os.ReadDir(downloads); err == nil {
		var files []string
		for _, ent := range entries {
			if ent.IsDir() || !strings.EqualFold(filepath.Ext(ent.Name()), ".tdf") {
				continue
			}
			files = append(files, ent.Name())
		}
		sort.Strings(files)
		for _, fn := range files {
			if err := parseMenuEntries(filepath.Join(downloads, fn), fn, ds); err != nil {
				return err
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}

// nextSlotIndex jumps forward past a gap in canbuild numbering, returning the
// next index that has content.
func nextSlotIndex(sub *tdf.Section, from int) int {
	for j := from + 1; j <= from+50; j++ {
		if w := strings.ToUpper(strings.TrimSpace(sub.String(fmt.Sprintf("canbuild%d", j)))); w != "" {
			return j - 1 // outer loop will ++ and land on j
		}
	}
	return from + 50
}

// menuEntryRe extracts a single [MENUENTRY] body.
var menuEntryRe = regexp.MustCompile(`(?si)\[MENUENTRY\d*\]\s*\{(.*?)\}`)

// fieldRe extracts KEY=VALUE; ensuring KEY is at a word boundary so MENU doesn't match UNITMENU.
var fieldReTemplate = `(?i)(?:^|[^A-Za-z_])%s\s*=\s*([^;]+);`

// parseMenuEntries reads one download/*.tdf and appends every entry to ds.
func parseMenuEntries(path, baseName string, ds *Dataset) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := stripComments(string(data))
	matches := menuEntryRe.FindAllStringSubmatch(text, -1)
	for _, m := range matches {
		body := m[1]
		builder := strings.ToUpper(strings.TrimSpace(extractField(body, "UNITMENU")))
		unit := strings.ToUpper(strings.TrimSpace(extractField(body, "UNITNAME")))
		if builder == "" || unit == "" {
			continue
		}
		menu, _ := strconv.Atoi(strings.TrimSpace(extractField(body, "MENU")))
		button, _ := strconv.Atoi(strings.TrimSpace(extractField(body, "BUTTON")))
		ds.Build.MenuEntries = append(ds.Build.MenuEntries, MenuEntry{
			Builder: builder,
			Menu:    menu,
			Button:  button,
			Unit:    unit,
			Source:  baseName,
		})
	}
	return nil
}

func extractField(body, key string) string {
	re := regexp.MustCompile(fmt.Sprintf(fieldReTemplate, regexp.QuoteMeta(key)))
	m := re.FindStringSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

var (
	lineCommentRe  = regexp.MustCompile(`(?m)//.*?$`)
	blockCommentRe = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

func stripComments(s string) string {
	s = lineCommentRe.ReplaceAllString(s, "")
	s = blockCommentRe.ReplaceAllString(s, "")
	return s
}

// buildSlots merges CanBuild + MenuEntries into ds.Build.Slots.
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

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
