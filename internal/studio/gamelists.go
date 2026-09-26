package studio

import (
	"path"
	"sort"
	"strings"

	"github.com/coreprime/kbot-engine/games"
	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gamedata/common"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// isKingdoms reports whether the session's game is TA: Kingdoms, whose build
// menus (canbuild/ directories) and sides the game adapter resolves.
func (sess *Session) isKingdoms() bool {
	return games.Resolve(sess.game).ID() == "takingdoms"
}

// buildOptions returns the units a builder can construct, lower-cased, in
// menu order: the list the unit viewer shows and the sandbox's build menu
// uses. For TA the lists follow the game (taBuildLists) and are resolved once
// per session; TA: Kingdoms keeps the adapter's canbuild/ resolution.
func (sess *Session) buildOptions(unit string) []string {
	if sess.isKingdoms() {
		return sess.palettes().BuildOptions(unit)
	}
	sess.buildListsOnce.Do(func() { sess.buildLists = taBuildLists(sess.vfs) })
	return sess.buildLists[strings.ToUpper(strings.TrimSpace(unit))]
}

// taBuildLists resolves every TA builder's build menu the way TA 3.1c
// assembles it:
//
//   - only a unit whose FBI sets Builder=1 has a list;
//   - its [CANBUILD] entry in gamedata/sidedata.tdf (the first [CANBUILD],
//     the first subsection named after the unit) is read canbuild1,
//     canbuild2, ... up to the first missing number, names that match no
//     unit skipped, at most 30 (kbot-io's CanBuildBuilder.BuildList);
//   - each download/*.tdf, in listing order, contributes its first five
//     sections whatever their names (DownloadFile.Menus); an entry counts
//     when UNITMENU names a builder and UNITNAME a unit;
//   - a list holds at most 31 units in all.
//
// Download additions follow the CANBUILD entries, ordered by MENU page and
// BUTTON as the menu places them; a unit already on the list is not
// repeated. The result maps the builder (upper-case) to lower-case names.
func taBuildLists(vfs *filesystem.VirtualFileSystem) map[string][]string {
	out := map[string][]string{}
	if vfs == nil {
		return out
	}
	units, builders := unitTable(vfs)
	known := func(name string) bool { return units[strings.ToUpper(name)] }
	count := map[string]int{}

	for _, p := range []string{"gamedata/sidedata.tdf", "gamedata/SIDEDATA.tdf", "GameData/sidedata.tdf"} {
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		var sd ta.SideData
		if tdf.Unmarshal(data, &sd) != nil {
			break
		}
		for b := range builders {
			list := sd.CanBuild.Builder(b)
			if list == nil {
				continue
			}
			for _, name := range list.BuildList(known) {
				out[b] = append(out[b], strings.ToLower(name))
			}
			count[b] = len(out[b])
		}
		break
	}

	type addition struct {
		menu, button, seq int
		name              string
	}
	extras := map[string][]addition{}
	seq := 0
	for _, file := range listTDFs(vfs, "download") {
		data, err := vfs.ReadFile(file)
		if err != nil {
			continue
		}
		var df common.DownloadFile
		if tdf.Unmarshal(data, &df) != nil {
			continue
		}
		for _, e := range df.Menus() {
			b := strings.ToUpper(strings.TrimSpace(e.UnitMenu))
			if !builders[b] || !known(e.UnitName) || count[b] >= common.BuildListLimit {
				continue
			}
			count[b]++
			seq++
			extras[b] = append(extras[b], addition{int(uint8(e.Menu)), int(uint8(e.Button)), seq, strings.ToLower(strings.TrimSpace(e.UnitName))})
		}
	}
	for b, adds := range extras {
		sort.Slice(adds, func(i, j int) bool {
			if adds[i].menu != adds[j].menu {
				return adds[i].menu < adds[j].menu
			}
			if adds[i].button != adds[j].button {
				return adds[i].button < adds[j].button
			}
			return adds[i].seq < adds[j].seq
		})
		seen := map[string]bool{}
		for _, n := range out[b] {
			seen[n] = true
		}
		for _, a := range adds {
			if !seen[a.name] {
				seen[a.name] = true
				out[b] = append(out[b], a.name)
			}
		}
	}
	return out
}

// unitTable reads units/*.fbi: every unit name (upper-case) and the ones
// whose Builder flag is set.
func unitTable(vfs *filesystem.VirtualFileSystem) (units, builders map[string]bool) {
	units, builders = map[string]bool{}, map[string]bool{}
	for _, file := range listFiles(vfs, "units", ".fbi") {
		data, err := vfs.ReadFile(file)
		if err != nil {
			continue
		}
		var u ta.Unit
		if tdf.Unmarshal(data, &u) != nil || u.Info.UnitName == "" {
			continue
		}
		name := strings.ToUpper(u.Info.UnitName)
		units[name] = true
		if u.Info.Builder != 0 {
			builders[name] = true
		}
	}
	return units, builders
}

// listTDFs lists dir's .tdf files (see listFiles).
func listTDFs(vfs *filesystem.VirtualFileSystem, dir string) []string {
	return listFiles(vfs, dir, ".tdf")
}

// listFiles lists the files directly in dir whose extension is ext (ignoring
// case), as VFS paths ordered by name with ASCII letters upper-cased, the
// order the game enumerates a directory's loose files in.
func listFiles(vfs *filesystem.VirtualFileSystem, dir, ext string) []string {
	names, err := vfs.ListDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range names {
		if strings.EqualFold(path.Ext(n), ext) && !vfs.IsDir(path.Join(dir, n)) {
			out = append(out, path.Join(dir, n))
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToUpper(out[i]) < strings.ToUpper(out[j]) })
	return out
}

// playableSides returns the sidedata sides the sandbox offers, with each
// side's number. TA reads SIDE0, SIDE1, ... up to the first missing number,
// at most five (kbot-io's GameSides); a side's number is its n. TA:
// Kingdoms keeps every SIDE section in file order.
func playableSides(sd *ta.SideData, kingdoms bool) ([]*ta.Side, []int) {
	var sides []*ta.Side
	var nums []int
	if kingdoms {
		for i := range sd.Sides {
			sides = append(sides, &sd.Sides[i])
			nums = append(nums, i)
		}
		return sides, nums
	}
	for i, s := range sd.GameSides() {
		sides = append(sides, s)
		nums = append(nums, i)
	}
	return sides, nums
}
