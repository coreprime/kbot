package studio

import (
	"net/http"
	"strings"

	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
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

// gameHost is the in-process authoritative game server. Opening a sandbox in
// the browser connects to this over a websocket, so the simulation runs here in
// the kbot process rather than in a throwaway in-browser engine.
var gameHost *gameserver.Server

// startGameHost constructs the in-process game server backed by the studio VFS.
// It must run after the VFS is mounted; the spawn provider reads the VFS lazily
// when a client first spawns a unit.
func startGameHost() {
	gameHost = gameserver.NewServer(vfsSpawnFunc(), hostSeed, hostInputDelay)
}

// registerHostAPI mounts the game host's websocket endpoint and the
// sandbox-discovery API on the studio mux.
func registerHostAPI(mux *http.ServeMux) {
	mux.Handle("/host/ws", gameHost)
	mux.HandleFunc("/api/studio/sandboxes", handleSandboxList)
}

// vfsSpawnFunc resolves Spawn orders against the studio VFS: it parses the
// unit's FBI and converts it (with its weapon stats) into the simulation's
// fixed-point stat block. Piece-animation bindings (COB) are not attached yet —
// units move, fight and die, but render in their rest pose until the COB
// delivery pass lands.
func vfsSpawnFunc() sim.SpawnFunc {
	return func(name string) (*sim.UnitMeta, sim.Binding) {
		unit, err := loadUnitFBI(strings.ToLower(strings.TrimSuffix(name, ".fbi")))
		if err != nil {
			return nil, nil
		}
		meta := gameserver.MetaFromUnitInfo(name, &unit.Info, resolveWeaponSection)
		return meta, nil
	}
}

// resolveWeaponSection adapts the studio VFS weapon loader to the meta
// converter's resolver signature.
func resolveWeaponSection(ref string) (ta.Weapon, bool) {
	sec := loadWeaponSection(ref)
	if sec == nil {
		return ta.Weapon{}, false
	}
	return *sec, true
}

// handleSandboxList reports the active sandbox sessions for the Join picker.
// Editor sessions are excluded; unclassified matches (e.g. a default match) are
// treated as sandboxes so they remain visible during manual testing.
func handleSandboxList(w http.ResponseWriter, _ *http.Request) {
	all := gameHost.Sessions()
	out := make([]gameserver.SessionInfo, 0, len(all))
	for _, s := range all {
		if s.Kind == "editor" {
			continue
		}
		out = append(out, s)
	}
	writeJSON(w, out)
}
