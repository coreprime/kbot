package gamevfs

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/hpi/common"
)

// gameHPILimit is how many *.hpi archives TA 3.1c mounts from its
// directory.
const gameHPILimit = 10

// Archive groups in TA 3.1c's mount order. Within a group archives mount in
// ASCII upper-case name order.
const (
	groupRevision = iota // rev31.gp3
	groupCCX             // *.ccx
	groupUFO             // *.ufo
	groupHPI             // the first ten *.hpi that open
	groupDisc            // *.hpi reached only by the disc-root scan
	groupOther           // anything else, which the game never scans
)

// ExportShadow is an exported file that a source the game reads first also
// provides, so the game ignores the exported copy.
type ExportShadow struct {
	Path string `json:"path"`
	// By names the sources that win: archive names, or "loose file" for a
	// loose file in the game directory, which beats every archive.
	By []string `json:"by"`
}

// ExportCheck says where an archive exported into the base install's game
// directory would land in TA 3.1c's mount order, and which of its files the
// game would take from elsewhere.
type ExportCheck struct {
	// Archive is the exported file name, such as "mymod.ufo".
	Archive string `json:"archive"`
	// Checked is false when the install is not mounted in game order (TA:
	// Kingdoms, or a custom install of version 2 archives); the other
	// fields are then empty apart from Notes.
	Checked bool `json:"checked"`
	// Mounted reports whether the game would mount the archive at all.
	Mounted bool `json:"mounted"`
	// Position is the archive's 1-based lookup position among the Of
	// archives the game would mount.
	Position int `json:"position,omitempty"`
	Of       int `json:"of,omitempty"`
	// OutrankedBy lists, in lookup order, the archives the game consults
	// before the exported one.
	OutrankedBy []string `json:"outrankedBy"`
	// Displaced names an *.hpi archive of the install that the export
	// pushes past the ten-*.hpi limit.
	Displaced string `json:"displaced,omitempty"`
	// Shadowed lists the exported files the game takes from another source.
	Shadowed []ExportShadow `json:"shadowed"`
	// Notes are the warnings to show before the download.
	Notes []string `json:"notes"`
	// Hint explains how TA 3.1c ranks archives (NameOrderHint) when the
	// export was checked.
	Hint string `json:"hint,omitempty"`
}

// LooseSource labels a loose file of the install in ExportShadow.By.
const LooseSource = "loose file"

// NameOrderHint explains how TA 3.1c ranks archives, for export dialogs.
const NameOrderHint = "TA 3.1c mounts rev31.gp3, then every *.ccx, then every *.ufo, then the first ten *.hpi, " +
	"each group in ASCII upper-case name order, and reads each file from the first archive that holds it. " +
	"A .ufo has no count limit and ranks above every .hpi; within a group, a name that sorts earlier ranks higher."

type rankedArchive struct {
	name  string
	upper string
	group int
	index int // lookup position in the current mount, for stable ties
}

// CheckExport works out where an archive named archive (with its
// extension) would rank if it were copied into the game directory of the
// install vfs mounts, and which of files (VFS paths of its contents) the
// game would read from a source it consults first. Layers labelled
// skipLabel (the workspace overlay the export is built from) are ignored.
//
// Archives from every context directory of vfs are treated as one game
// directory, which is where the game would find them.
func CheckExport(vfs *filesystem.VirtualFileSystem, archive string, files []string, skipLabel string) ExportCheck {
	check := ExportCheck{Archive: archive, OutrankedBy: []string{}, Shadowed: []ExportShadow{}, Notes: []string{}}
	rep := Report(vfs)
	if !strings.Contains(rep.Discovery, filesystem.DiscoveryGameOrder.String()) {
		check.Notes = append(check.Notes, "This install is not mounted in TA 3.1c's archive order, so the export's rank is not checked.")
		return check
	}
	check.Checked = true
	check.Hint = NameOrderHint

	exportGroup := archiveGroup(archive)
	if exportGroup == groupOther {
		check.Notes = append(check.Notes, fmt.Sprintf("TA 3.1c does not scan %q archives; export as .ufo, .ccx or .hpi.", filepath.Ext(archive)))
		return check
	}
	if exportGroup == groupRevision {
		check.Notes = append(check.Notes, "TA 3.1c mounts only rev31.gp3 of the *.gp3 archives.")
		return check
	}

	discScan := false
	for _, s := range vfs.SkippedArchives() {
		if s.Reason == filesystem.SkipAlreadyMounted {
			discScan = true
			break
		}
	}
	for _, m := range rep.Mounted {
		if m.Note != "" {
			discScan = true
		}
	}

	var ranked []rankedArchive
	for _, m := range rep.Mounted {
		if common.EqualFoldASCII(m.Name, archive) {
			continue // the export replaces this file
		}
		ranked = append(ranked, rankedArchive{name: m.Name, upper: common.ToUpperASCII(m.Name), group: archiveGroup(m.Name), index: m.Position})
	}
	exp := rankedArchive{name: archive, upper: common.ToUpperASCII(archive), group: exportGroup, index: len(rep.Mounted) + 1}
	withExport := placeHPIs(append(append([]rankedArchive(nil), ranked...), exp), discScan)
	withoutExport := placeHPIs(ranked, discScan)

	pos := -1
	for i, a := range withExport {
		if a.index == exp.index {
			pos = i
			break
		}
	}
	if pos < 0 {
		check.Notes = append(check.Notes, fmt.Sprintf(
			"TA 3.1c mounts only the first %d *.hpi archives that open, and %d archives in this install sort before %s, so the game would never mount it. Export as .ufo, or choose a name that sorts earlier.",
			gameHPILimit, countHPIsBefore(ranked, exp.upper), archive))
		return check
	}
	check.Mounted = true
	check.Position = pos + 1
	check.Of = len(withExport)
	outrank := make(map[string]bool, pos)
	for _, a := range withExport[:pos] {
		check.OutrankedBy = append(check.OutrankedBy, a.name)
		outrank[a.name] = true
	}
	if withExport[pos].group == groupDisc {
		check.Notes = append(check.Notes, fmt.Sprintf(
			"%s sorts after the first %d *.hpi archives, so the game mounts it only through the disc-root scan, after every other archive (and not at all when the disc root is a CD).",
			archive, gameHPILimit))
	}
	if d := displacedHPI(withoutExport, withExport); d != "" {
		check.Displaced = d
		check.Notes = append(check.Notes, fmt.Sprintf(
			"Adding %s pushes %s past the ten-*.hpi limit: the game then reaches %s only through the disc-root scan, if at all.",
			archive, d, d))
	}

	mountedNames := make(map[string]bool, len(rep.Mounted))
	for _, m := range rep.Mounted {
		mountedNames[m.Name] = true
	}
	for _, f := range files {
		var by []string
		for _, l := range vfs.GetFileLayers(f) {
			switch {
			case l.Source == skipLabel:
			case mountedNames[l.Source]:
				if outrank[l.Source] {
					by = append(by, l.Source)
				}
			default:
				by = append(by, LooseSource)
			}
		}
		if len(by) > 0 {
			check.Shadowed = append(check.Shadowed, ExportShadow{Path: f, By: by})
		}
	}
	if n := len(check.Shadowed); n > 0 {
		check.Notes = append(check.Notes, fmt.Sprintf(
			"%d of the %d exported files are also provided by sources the game reads first, so the game ignores the exported copies. Ship those files as loose files in the game directory for them to take effect.",
			n, len(files)))
	}
	return check
}

// archiveGroup returns the mount-order group of an archive file name.
func archiveGroup(name string) int {
	switch common.ToLowerASCII(filepath.Ext(name)) {
	case ".gp3":
		return groupRevision
	case ".ccx":
		return groupCCX
	case ".ufo":
		return groupUFO
	case ".hpi":
		return groupHPI
	default:
		return groupOther
	}
}

// placeHPIs assigns each *.hpi archive to the directory group (the first
// ten by name) or the disc-root group, dropping the rest when no disc-root
// scan runs, and returns the archives in lookup order.
func placeHPIs(archives []rankedArchive, discScan bool) []rankedArchive {
	var hpis, rest []rankedArchive
	for _, a := range archives {
		if a.group == groupHPI || a.group == groupDisc {
			hpis = append(hpis, a)
		} else {
			rest = append(rest, a)
		}
	}
	sortByName(hpis)
	for i := range hpis {
		if i < gameHPILimit {
			hpis[i].group = groupHPI
		} else {
			hpis[i].group = groupDisc
		}
	}
	out := rest
	for _, a := range hpis {
		if a.group == groupDisc && !discScan {
			continue
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].group != out[j].group {
			return out[i].group < out[j].group
		}
		if out[i].upper != out[j].upper {
			return out[i].upper < out[j].upper
		}
		return out[i].index < out[j].index
	})
	return out
}

func sortByName(a []rankedArchive) {
	sort.SliceStable(a, func(i, j int) bool {
		if a[i].upper != a[j].upper {
			return a[i].upper < a[j].upper
		}
		return a[i].index < a[j].index
	})
}

// countHPIsBefore counts the *.hpi archives whose name sorts before upper.
func countHPIsBefore(archives []rankedArchive, upper string) int {
	n := 0
	for _, a := range archives {
		if (a.group == groupHPI || a.group == groupDisc) && a.upper < upper {
			n++
		}
	}
	return n
}

// displacedHPI returns the *.hpi archive that is in the directory group of
// before but not of after.
func displacedHPI(before, after []rankedArchive) string {
	inAfter := map[string]bool{}
	for _, a := range after {
		if a.group == groupHPI {
			inAfter[a.name] = true
		}
	}
	for _, a := range before {
		if a.group == groupHPI && !inAfter[a.name] {
			return a.name
		}
	}
	return ""
}
