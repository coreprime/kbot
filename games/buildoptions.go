package games

import (
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/gamedata/common"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/tdf"
)

// Build-option resolution.
//
// Which units a builder can construct is game data with two shipped shapes:
//
//   - Total Annihilation: gamedata/sidedata.tdf's [CANBUILD] section holds a
//     subsection per builder with canbuild1..N entries, and add-on units
//     extend menus through download/*.tdf [MENUENTRY*] sections
//     (UNITMENU= the builder, UNITNAME= the new unit, MENU/BUTTON= the
//     placement) — the mechanism AFark.ufo and every downloadable unit use.
//   - TA: Kingdoms: a canbuild/<builder>/<unit>.tdf file grants the pairing;
//     the file's [Menu] Priority orders the entries. Kingdoms mods can also
//     ship TA-style download TDFs, so both games honour those.
//
// Each shape unmarshals into its typed gamedata model (ta.SideData,
// tak.CanBuildGrant, common.DownloadFile) like every other TA format.
// SidedataBuildOptions, CanbuildDirOptions and DownloadMenuOptions are the
// shared resolvers; each game's adapter composes them in its BuildOptions.

// SidedataBuildOptions reads TA's [CANBUILD] table: builder (upper-case) →
// ordered buildable names (lower-case).
func SidedataBuildOptions(fs VFS) map[string][]string {
	out := map[string][]string{}
	for _, p := range []string{"gamedata/sidedata.tdf", "gamedata/SIDEDATA.tdf", "GameData/sidedata.tdf"} {
		data, err := fs.ReadFile(p)
		if err != nil {
			continue
		}
		var sd ta.SideData
		if err := tdf.Unmarshal(data, &sd); err != nil {
			continue
		}
		for _, b := range sd.CanBuild.Builders {
			builder := strings.ToUpper(strings.TrimSpace(b.Name))
			type ent struct {
				n    int
				name string
			}
			var ents []ent
			for key, value := range b.Entries {
				k := strings.ToLower(strings.TrimSpace(key))
				if !strings.HasPrefix(k, "canbuild") {
					continue
				}
				n, err := strconv.Atoi(strings.TrimPrefix(k, "canbuild"))
				if err != nil {
					continue
				}
				if v := strings.ToLower(strings.TrimSpace(value)); v != "" {
					ents = append(ents, ent{n, v})
				}
			}
			sort.Slice(ents, func(i, j int) bool { return ents[i].n < ents[j].n })
			for _, e := range ents {
				out[builder] = append(out[builder], e.name)
			}
		}
		break
	}
	return out
}

// CanbuildDirOptions reads TA:K's canbuild/<builder>/<unit>.tdf grants:
// builder (upper-case) → buildable names ordered by [Menu] Priority then
// name.
func CanbuildDirOptions(fs VFS) map[string][]string {
	type ent struct {
		prio int
		name string
	}
	byBuilder := map[string][]ent{}
	for _, p := range fs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "canbuild/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		parts := strings.Split(lower, "/")
		if len(parts) != 3 {
			continue
		}
		builder := strings.ToUpper(parts[1])
		name := strings.TrimSuffix(path.Base(lower), ".tdf")
		prio := 1 << 20
		if data, err := fs.ReadFile(p); err == nil {
			var grant tak.CanBuildGrant
			if err := tdf.Unmarshal(data, &grant); err == nil && grant.Menu.Priority != 0 {
				prio = grant.Menu.Priority
			}
		}
		byBuilder[builder] = append(byBuilder[builder], ent{prio, name})
	}
	out := map[string][]string{}
	for b, ents := range byBuilder {
		sort.Slice(ents, func(i, j int) bool {
			if ents[i].prio != ents[j].prio {
				return ents[i].prio < ents[j].prio
			}
			return ents[i].name < ents[j].name
		})
		for _, e := range ents {
			out[b] = append(out[b], e.name)
		}
	}
	return out
}

// DownloadMenuOptions reads download/*.tdf [MENUENTRY*] sections — the
// add-on mechanism both games' mods use — returning builder (upper-case) →
// added names ordered by (MENU, BUTTON, file order).
func DownloadMenuOptions(fs VFS) map[string][]string {
	type ent struct {
		menu, button, seq int
		name              string
	}
	byBuilder := map[string][]ent{}
	seq := 0
	for _, p := range fs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "download/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := fs.ReadFile(p)
		if err != nil {
			continue
		}
		var dl common.DownloadFile
		if err := tdf.Unmarshal(data, &dl); err != nil {
			continue
		}
		for _, m := range dl.Entries {
			builder := strings.ToUpper(strings.TrimSpace(m.UnitMenu))
			name := strings.ToLower(strings.TrimSpace(m.UnitName))
			if builder == "" || name == "" {
				continue
			}
			seq++
			byBuilder[builder] = append(byBuilder[builder], ent{m.Menu, m.Button, seq, name})
		}
	}
	out := map[string][]string{}
	for b, ents := range byBuilder {
		sort.Slice(ents, func(i, j int) bool {
			if ents[i].menu != ents[j].menu {
				return ents[i].menu < ents[j].menu
			}
			if ents[i].button != ents[j].button {
				return ents[i].button < ents[j].button
			}
			return ents[i].seq < ents[j].seq
		})
		for _, e := range ents {
			out[b] = append(out[b], e.name)
		}
	}
	return out
}

// MergeBuildOptions appends extras onto base, deduplicating while keeping
// first-seen order.
func MergeBuildOptions(base, extras []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, lists := range [][]string{base, extras} {
		for _, n := range lists {
			if !seen[n] {
				seen[n] = true
				out = append(out, n)
			}
		}
	}
	return out
}
