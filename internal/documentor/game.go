package documentor

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/games"
	_ "github.com/coreprime/kbot/games/takingdoms"
	_ "github.com/coreprime/kbot/games/totala"
)

// Game identifies which title's reference catalogue we're rendering. Values
// are the canonical games-registry ids ("totala", "takingdoms"); the
// documentor layers its own filename prefixes and per-game rendering rules
// on top, but identity and display names come from the registry.
type Game string

const (
	// GameTotalA is Total Annihilation (1997) + Core Contingency + Battle Tactics.
	GameTotalA Game = "totala"

	// GameTAKingdoms is Total Annihilation: Kingdoms (1999) + Iron Plague.
	GameTAKingdoms Game = "takingdoms"
)

// gameAliases maps the CLI shorthand spellings onto registry ids.
var gameAliases = map[string]string{
	"":         "totala",
	"ta":       "totala",
	"tak":      "takingdoms",
	"kingdoms": "takingdoms",
}

// ParseGame coerces a CLI string into a Game value: shorthand aliases map to
// canonical ids and anything else must be a registered game id, so a game
// added to the registry is documentable without touching this file.
func ParseGame(s string) (Game, error) {
	id := strings.ToLower(strings.TrimSpace(s))
	if canonical, ok := gameAliases[id]; ok {
		id = canonical
	}
	if _, ok := games.Lookup(id); !ok {
		return "", fmt.Errorf("unknown game %q (want one of: %s)", s, strings.Join(games.IDs(), ", "))
	}
	return Game(id), nil
}

// Prefix is the per-game filename/identifier prefix:
//   - totala     → "ta"
//   - takingdoms → "tak"
func (g Game) Prefix() string {
	switch g {
	case GameTAKingdoms:
		return "tak"
	default:
		return "ta"
	}
}

// HumanName returns the player-friendly title from the games registry.
func (g Game) HumanName() string {
	return games.Resolve(string(g)).Name()
}

// PortraitDir is the per-game portrait subdirectory (relative to target).
func (g Game) PortraitDir() string {
	return "img/" + g.Prefix() + "-units"
}
