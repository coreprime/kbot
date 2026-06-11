package studio

import (
	"net/http"
	"strings"

	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// tilesetOption is one selectable terrain set for the New-map dialog.
type tilesetOption struct {
	Slug           string `json:"slug"`
	Label          string `json:"label"`
	DefaultTileset string `json:"defaultTileset"`
}

// taWorlds is Total Annihilation's canonical world list (slug → label →
// .ota planet value). TA has no per-install tileset registry, so this is the
// authoritative set.
var taWorlds = []tilesetOption{
	{"greenworld", "Green", "Green"},
	{"metal", "Metal", "Metal"},
	{"mars", "Mars", "Desert"},
	{"moon", "Moon", "Lunar"},
	{"archipelago", "Archipelago", "Water"},
	{"lava", "Lava", "Lava"},
	{"acid", "Acid", "Acid"},
	{"slate", "Slate", "Slate"},
}

// handleTilesets returns the terrain sets selectable when creating a new map,
// chosen per game. Total Annihilation uses its fixed world list; TA:Kingdoms
// uses its playable kingdoms (read from gamedata/sidedata.tdf — the same source
// that drives palettes — so Iron Plague's Creon shows up automatically), since
// a TA:K map's terrain set is its kingdom.
func (sess *Session) handleTilesets(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var out []tilesetOption
	if sess.game == kbotctx.GameTAKingdoms {
		out = sess.takKingdomTilesets()
	}
	if len(out) == 0 {
		out = taWorlds
	}
	writeJSON(w, map[string]any{"game": sess.game, "tilesets": out})
}

// takKingdomTilesets lists the playable TA:K kingdoms from sidedata, keeping
// only those with a terrain palette (Aramon/Taros/Veruna/Zhon/Creon — not the
// Lifeforms/NPC/Monster pseudo-sides).
func (sess *Session) takKingdomTilesets() []tilesetOption {
	data, err := sess.vfs.ReadFile("gamedata/sidedata.tdf")
	if err != nil {
		return nil
	}
	var sides []tak.Side
	if err := tdf.Unmarshal(data, &sides); err != nil {
		return nil
	}
	var out []tilesetOption
	for _, s := range sides {
		name := strings.ToLower(strings.TrimSpace(s.Name))
		if _, ok := assets.TAKPalettes[name]; !ok {
			continue
		}
		out = append(out, tilesetOption{
			Slug:           name,
			Label:          capitalize(name),
			DefaultTileset: name,
		})
	}
	return out
}

// capitalize upper-cases the first letter (ASCII kingdom names: aramon → Aramon).
func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
