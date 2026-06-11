package studio

import (
	"net/http"
	"strings"

	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/games"
	"github.com/coreprime/kbot/internal/gameserver"
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
		// games.UnitMetaFromFBI runs both weapon passes (TA references +
		// TA:K inline sections) so the authority fights with the same
		// stats the browser clients computed from /api/studio/unit.
		meta, err := games.UnitMetaFromFBI(name, data, sess.resolveWeaponSection)
		if err != nil {
			return nil, nil
		}
		return meta, nil
	}
}

// resolveWeaponSection adapts the studio VFS weapon loader to the meta
// converter's resolver signature.
func (sess *Session) resolveWeaponSection(ref string) (ta.Weapon, bool) {
	sec := sess.loadWeaponSection(ref)
	if sec == nil {
		return ta.Weapon{}, false
	}
	return *sec, true
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
