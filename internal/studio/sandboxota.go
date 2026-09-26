package studio

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/gamedata/tak"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// sandboxPlayers is the player count the sandbox picks a map's schema for
// when the request names none: the smallest game the game starts, one
// player against one opponent.
const sandboxPlayers = 2

// sandboxOTA is what the sandbox takes from a map's .ota: from the schema a
// skirmish of the sandbox's player count would use, its SurfaceMetal and its
// start positions, and for TA: Kingdoms the sea level.
type sandboxOTA struct {
	// SeaLevel is a TA: Kingdoms OTA's sealevel (0 when it has none). TA
	// reads its sea level from the TNT header alone, so it is 0 for TA.
	SeaLevel int
	// Schema names the schema used ("Schema 2 (Network 1)"); empty when the
	// map has none.
	Schema string
	// SurfaceMetal is the metal every plot starts with, as the game stores
	// it (a byte; a negative value is 0). 0 for TA: Kingdoms maps.
	SurfaceMetal int
	// Starts are the schema's start positions in [specials] order, numbered
	// the game's way, in the OTA's own units.
	Starts []ta.StartPosition
}

// readSandboxOTA reads a map's .ota for the sandbox. For Total Annihilation
// the schema is the one a skirmish or multiplayer game of players picks: the
// game tries the types Network 1..4 over the contiguous Schema 0, Schema 1,
// ... and prefers a schema with exactly players start positions, else the
// one with the most (see ta.GlobalHeader.MultiplayerSchema). A map with no
// such schema, a campaign mission, uses the schema the mission plays at
// medium difficulty, else the first schema the game can reach. Start
// positions are numbered as the game numbers them:
// StartPosN is slot N-1, StartPos0 slot 0, and an unnumbered StartPos takes
// the next implicit number. Nothing is invented: a schema with no start
// positions gives none. TA: Kingdoms maps take their [Map Data] specials
// with the same numbering. Returns nil for text the game would not load as
// a map.
func readSandboxOTA(data []byte, isTAK bool, players int) *sandboxOTA {
	if isTAK {
		return readSandboxOTATAK(data)
	}
	m, err := ta.ReadMap(data)
	if err != nil {
		return nil
	}
	out := &sandboxOTA{}
	schema := m.Header.MultiplayerSchema(players)
	if schema == nil {
		schema = m.Header.CampaignSchema(1)
	}
	if schema == nil {
		if all := m.Header.GameSchemas(); len(all) > 0 {
			schema = all[0]
		}
	}
	if schema == nil {
		return out
	}
	for n, s := range m.Header.GameSchemas() {
		if s == schema {
			out.Schema = fmt.Sprintf("Schema %d", n)
			if t := strings.TrimSpace(s.Type); t != "" {
				out.Schema += " (" + t + ")"
			}
			break
		}
	}
	if schema.SurfaceMetal > 0 {
		out.SurfaceMetal = int(uint8(schema.SurfaceMetal))
	}
	out.Starts = schema.StartPositions()
	return out
}

// readSandboxOTATAK reads a TA: Kingdoms .ota: its sea level and the start
// positions among its [Map Data] specials, numbered as ta.Schema numbers them.
func readSandboxOTATAK(data []byte) *sandboxOTA {
	m, err := tak.ReadMap(data)
	if err != nil {
		return nil
	}
	out := &sandboxOTA{}
	for k, v := range m.Header.Remaining {
		if strings.EqualFold(k, "sealevel") {
			out.SeaLevel = int(tdf.Atol(v))
		}
	}
	md := m.Header.MapData
	if md == nil || md.Specials == nil {
		return out
	}
	// The numbering rule lives on ta.Schema; lift the specials into one.
	var s ta.Schema
	s.Specials = &ta.Specials{}
	for _, p := range md.Specials.Items {
		s.Specials.Items = append(s.Specials.Items, ta.Special{
			Key: p.Key, SpecialWhat: p.SpecialWhat, XPos: p.XPos, ZPos: p.ZPos,
		})
	}
	out.Schema = "Map Data"
	out.Starts = s.StartPositions()
	return out
}

// otaPathFor returns the .ota path beside a map's .tnt.
func otaPathFor(mapPath string) string {
	if i := strings.LastIndex(mapPath, "."); i > strings.LastIndex(mapPath, "/") {
		return mapPath[:i] + ".ota"
	}
	return mapPath + ".ota"
}

// sandboxOTAFor reads the .ota beside mapPath, or nil when it is missing or
// unreadable.
func (sess *Session) sandboxOTAFor(mapPath string, isTAK bool, players int) *sandboxOTA {
	data, err := sess.vfs.ReadFile(otaPathFor(mapPath))
	if err != nil {
		return nil
	}
	return readSandboxOTA(data, isTAK, players)
}
