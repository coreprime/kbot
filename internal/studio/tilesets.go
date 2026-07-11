package studio

import (
	"net/http"

	"github.com/coreprime/kbot-engine/games"
)

// handleTilesets returns the terrain sets selectable when creating a new map.
// The game adapter owns the list (TA's fixed world list; TA:K's playable
// kingdoms from sidedata). An empty answer — e.g. a TA:K install with a
// missing sidedata.tdf — falls back to the TA world list so the New-map
// dialog always has something to offer.
func (sess *Session) handleTilesets(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	out := sess.palettes().Tilesets()
	if len(out) == 0 {
		out = games.Resolve("totala").NewAdapter(sess.vfs).Tilesets()
	}
	writeJSON(w, map[string]any{"game": sess.game, "tilesets": out})
}
