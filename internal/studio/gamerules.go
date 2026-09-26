package studio

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/coreprime/kbot-engine/games"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot/internal/unitdefs"
)

// gamerules.go — the session's view of the game's unit data tables: the
// weapon table (weapons/*.tdf by ID) and the movement classes
// (gamedata/moveinfo.tdf). The unit meta endpoint, the weapon catalogue, the
// weapon-bitmap endpoint, packs and the in-process game host all resolve
// through these, so they agree with each other and with the game.

// taRules reports whether the session's game follows TA 3.1c's unit rules
// (movement-class resolution with the game's defaults, resolved standing
// orders). TA: Kingdoms sessions keep their own handling.
func (sess *Session) taRules() bool {
	return games.Resolve(sess.game).ID() != "takingdoms"
}

// weaponFiles lists the weapon files the game loads, in the order it lists
// them: the .tdf files directly in weapons/, layer by layer, a path held by
// several layers once per copy (each read returns the active copy, as the
// game's loader does). Files in subdirectories of weapons/ and
// gamedata/weapons.tdf are not weapon sources.
func (sess *Session) weaponFiles() []unitdefs.WeaponFile {
	var out []unitdefs.WeaponFile
	for _, e := range sess.vfs.ListGameOrder("weapons", ".tdf", false) {
		if !ta.IsWeaponFile(e.Path) {
			continue
		}
		data, err := sess.vfs.ReadFile(e.Path)
		if err != nil {
			continue
		}
		out = append(out, unitdefs.WeaponFile{Path: e.Path, Data: data})
	}
	return out
}

// weaponFilesSig is a cheap signature of the weapon-file listing (paths,
// sources, sizes, which copy is active), used to rebuild the cached weapon
// table when a workspace adds, removes or rewrites a weapons file.
func (sess *Session) weaponFilesSig() string {
	var b strings.Builder
	for _, e := range sess.vfs.ListGameOrder("weapons", ".tdf", false) {
		b.WriteString(e.Path)
		b.WriteByte('|')
		b.WriteString(e.Source)
		b.WriteByte('|')
		b.WriteString(strconv.FormatInt(e.Size, 10))
		if e.Active {
			b.WriteString("|a")
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// weaponTable returns the game's weapon table for the session's VFS: each
// weapon in the slot its ID names, a later file's section replacing an
// earlier one with the same ID, names resolving to the lowest slot, sections
// without a valid ID skipped (see Warnings).
func (sess *Session) weaponTable() *unitdefs.WeaponTable {
	sig := sess.weaponFilesSig()
	sess.weaponTableMu.Lock()
	defer sess.weaponTableMu.Unlock()
	if sess.weaponTableVal == nil || sig != sess.weaponTableSig {
		sess.weaponTableVal = unitdefs.BuildWeaponTable(sess.weaponFiles())
		sess.weaponTableSig = sig
	}
	return sess.weaponTableVal
}

// moveClasses returns the decoded gamedata/moveinfo.tdf (every section; the
// game reads only [CLASS0]..[CLASS31], which ta.UnitInfo.Movement applies),
// or nil when the game ships none.
func (sess *Session) moveClasses() []ta.MovementClass {
	sess.moveClassOnce.Do(func() {
		for _, p := range []string{"gamedata/moveinfo.tdf", "gamedata/MOVEINFO.TDF", "GameData/moveinfo.tdf"} {
			data, err := sess.vfs.ReadFile(p)
			if err != nil {
				continue
			}
			if classes, err := unitdefs.LoadMoveClasses(data); err == nil {
				sess.moveClassList = classes
				break
			}
		}
	})
	return sess.moveClassList
}

// moveClassByName finds a movement class by its name= key among every
// moveinfo section, the lookup TA: Kingdoms sessions keep; nil when none
// matches.
func (sess *Session) moveClassByName(name string) *ta.MovementClass {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	classes := sess.moveClasses()
	for i := range classes {
		if strings.EqualFold(strings.TrimSpace(classes[i].Name), name) {
			return &classes[i]
		}
	}
	return nil
}

// handleWeaponWarnings serves what the game refuses, skips or replaces while
// building its weapon table from the session's weapons/*.tdf files: files it
// refuses for broken structure (none of their weapons load), sections
// without an ID or with one outside 0..255, and sections a later one with the
// same ID replaces.
func (sess *Session) handleWeaponWarnings(w http.ResponseWriter, _ *http.Request) {
	warnings := sess.weaponTable().Warnings
	if warnings == nil {
		warnings = []string{}
	}
	writeJSON(w, map[string]any{"warnings": warnings})
}
