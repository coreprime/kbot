package studio

import (
	"bytes"
	"net/http"
	"strconv"
	"strings"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-engine/games"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
	"github.com/coreprime/kbot/internal/gameserver"
	"github.com/coreprime/kbot/internal/unitdefs"
)

// hostSeed and hostInputDelay match the native `kbot host` defaults so a
// studio-hosted session behaves identically to the standalone server. The seed
// is shared by every match; independent sandboxes are still isolated worlds,
// and clients joining one match share its seed via the join handshake.
const (
	hostSeed       uint32 = 1
	hostInputDelay uint64 = 3
)

// startGameHost constructs the in-process game server backed by the studio VFS.
// It must run after the VFS is mounted; the spawn provider reads the VFS lazily
// when a client first spawns a unit.
func (sess *Session) startGameHost() {
	sess.gameHost = gameserver.NewServer(sess.vfsSpawnFunc(), sess.resolveCobBytes, hostSeed, hostInputDelay)
	// A hosted match that names a battlefield gets its authority world's height
	// field installed at creation, so the lockstep sim runs on the real map (its
	// bounds, slopes and water) rather than the flat grid. Clients derive the
	// identical grid from the same map file via /api/studio/sandbox-map.
	sess.gameHost.SetTerrainProvider(sess.buildHostTerrain)
}

// buildHostTerrain resolves a map path into the authority's sim height field.
// It reuses the same TNT extraction the sandbox-map JSON serves the browser —
// identical W/H/heights/sea level, at the shared cell size and height scale —
// so the host and every client step the same lockstep grid. A map that fails
// to load yields nil, leaving the match on the flat grid.
func (sess *Session) buildHostTerrain(mapPath string) *sim.Terrain {
	if mapPath == "" {
		return nil
	}
	terr, err := sess.loadSandboxTerrain(mapPath)
	if err != nil {
		return nil
	}
	return &sim.Terrain{
		W:           terr.W,
		H:           terr.H,
		CellWU:      fixed.FromFloat(sandboxCellWU),
		HeightScale: fixed.FromFloat(sandboxHeightScale),
		SeaLevel:    terr.SeaLevel,
		Data:        terr.Heights,
		Void:        terr.Voids,
		Metal:       surfaceMetalGrid(terr.W, terr.H, terr.SurfaceMetal),
	}
}

// surfaceMetalGrid is the per-cell metal a map starts with: every plot holds
// the schema's SurfaceMetal byte (nil for 0, a metal-less grid). The browser
// clients install the same flood from /api/studio/sandbox-map's surfaceMetal,
// so a hosted match and its clients agree on where extractors may stand.
func surfaceMetalGrid(w, h, surfaceMetal int) []uint8 {
	if surfaceMetal <= 0 || w <= 0 || h <= 0 {
		return nil
	}
	grid := make([]uint8, w*h)
	for i := range grid {
		grid[i] = uint8(surfaceMetal)
	}
	return grid
}

// registerHostAPI mounts the game host's websocket endpoint and the
// sandbox-discovery API on the studio mux.
func (sess *Session) registerHostAPI(mux *http.ServeMux) {
	mux.Handle("/host/ws", sess.gameHost)
	mux.HandleFunc("/api/studio/sandboxes", sess.handleSandboxList)
}

// vfsSpawnFunc resolves Spawn orders against the studio VFS: it parses the
// unit's FBI and converts it (with its weapon stats) into the simulation's
// fixed-point stat block. The match layers each unit's COB script on top via
// resolveCobBytes, so the authority runs the same animation + scripted
// weapon/death threads as the clients.
func (sess *Session) vfsSpawnFunc() sim.SpawnFunc {
	return func(name string) (*sim.UnitMeta, sim.Binding) {
		key := strings.ToLower(strings.TrimSuffix(name, ".fbi"))
		data, err := sess.loadUnitFBIBytes(key)
		if err != nil {
			return nil, nil
		}
		meta, err := sess.simUnitMeta(name, data, sess.weaponTable().Resolve)
		if err != nil {
			return nil, nil
		}
		return meta, nil
	}
}

// simUnitMeta builds a unit's sim stat block from its FBI bytes: the same
// pipeline the authoritative host and /api/studio/unit (which the browser
// clients spawn from) both run, so every side of a match fights and moves
// with identical stats. games.UnitMetaFromFBI runs both weapon passes (TA
// references + TA:K inline sections) and games.EnrichCombatMeta adds the
// exact-combat fields ([DAMAGE] tables, tick-domain reload, spray/accuracy
// angles, behavior classes, death blasts). For TA the game's rules then set
// the footprint and terrain limits (movement class with the game's
// defaults), the standing orders and the whole-tick reload; TA: Kingdoms
// keeps the class override it had.
func (sess *Session) simUnitMeta(name string, fbi []byte, resolve games.WeaponResolver) (*sim.UnitMeta, error) {
	meta, err := games.UnitMetaFromFBI(name, fbi, resolve)
	if err != nil {
		return nil, err
	}
	games.EnrichCombatMeta(meta, fbi, resolve)
	if !sess.taRules() {
		games.ApplyMovementClass(meta, sess.simMoveClassTable())
		return meta, nil
	}
	var u ta.Unit
	if err := tdf.Unmarshal(fbi, &u); err == nil {
		unitdefs.ApplyToSimMeta(meta, &u.Info, sess.moveClasses(), resolve)
	}
	return meta, nil
}

// simMoveClassTable lazily parses the game's gamedata/moveinfo.tdf into the
// class table games.ApplyMovementClass resolves TA: Kingdoms movement classes
// through; nil when the VFS ships none.
func (sess *Session) simMoveClassTable() games.MovementClasses {
	sess.simMoveClassOnce.Do(func() {
		for _, p := range []string{"gamedata/moveinfo.tdf", "gamedata/MOVEINFO.TDF", "GameData/moveinfo.tdf"} {
			data, err := sess.vfs.ReadFile(p)
			if err != nil {
				continue
			}
			classes, err := games.LoadMovementClasses(data)
			if err != nil {
				continue
			}
			sess.simMoveClasses = classes
			return
		}
	})
	return sess.simMoveClasses
}

// overrideFBI returns a unit's FBI text with the Change Weapon picker's
// per-slot substitutions made in its [UNITINFO]: an overridden slot's
// WeaponN names the substitute ("NONE" or "-" empties the slot). The meta
// builders then read every slot on its own, as if the FBI named that weapon
// there, so a slot that shares its weapon with an overridden one keeps its
// own weapon, and a death blast naming the same weapon is untouched. A
// substitute that cannot be written as a value (it holds a ';', say) names
// no weapon. The text is returned as it is when no slot is overridden or the
// FBI has no [UNITINFO].
func overrideFBI(fbi []byte, overrides [3]string) []byte {
	var subst [3]string
	changed := false
	for i, o := range overrides {
		o = strings.ToUpper(strings.TrimSpace(o))
		if o == "-" || (o != "" && tdf.CheckValue(o) != nil) {
			o = "NONE"
		}
		subst[i] = o
		changed = changed || o != ""
	}
	if !changed {
		return fbi
	}
	doc, err := tdf.Parse(bytes.NewReader(fbi))
	if err != nil {
		return fbi
	}
	info := doc.Section("UNITINFO")
	if info == nil {
		return fbi
	}
	for i, o := range subst {
		if o != "" {
			info.Set("Weapon"+strconv.Itoa(i+1), o)
		}
	}
	if out, err := doc.Bytes(); err == nil {
		return out
	}
	// Bytes edits the source text in place and refuses an addition it cannot
	// place there (after a section the file ends inside, say); Write lays
	// the whole document out afresh, with the same data.
	var buf bytes.Buffer
	if err := doc.Write(&buf); err != nil {
		return fbi
	}
	return buf.Bytes()
}

// handleSandboxList reports the active sandbox sessions for the Join picker.
// Editor sessions are excluded; unclassified matches (e.g. a default match) are
// treated as sandboxes so they remain visible during manual testing.
func (sess *Session) handleSandboxList(w http.ResponseWriter, _ *http.Request) {
	all := sess.gameHost.Sessions()
	out := make([]gameserver.SessionInfo, 0, len(all))
	for _, s := range all {
		if s.Kind == "editor" {
			continue
		}
		out = append(out, s)
	}
	writeJSON(w, out)
}
