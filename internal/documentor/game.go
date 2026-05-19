package documentor

import "fmt"

// Game identifies which Cavedog title's reference catalogue we're rendering.
type Game string

const (
	// GameTotalA is Total Annihilation (1997) + Core Contingency + Battle Tactics.
	GameTotalA Game = "totala"

	// GameTAKingdoms is Total Annihilation: Kingdoms (1999) + Iron Plague.
	GameTAKingdoms Game = "takingdoms"
)

// ParseGame coerces a CLI string into a Game value.
func ParseGame(s string) (Game, error) {
	switch s {
	case "", "totala", "ta":
		return GameTotalA, nil
	case "takingdoms", "tak", "kingdoms":
		return GameTAKingdoms, nil
	default:
		return "", fmt.Errorf("unknown game %q (want totala or takingdoms)", s)
	}
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

// HumanName returns the player-friendly title.
func (g Game) HumanName() string {
	switch g {
	case GameTAKingdoms:
		return "Total Annihilation: Kingdoms"
	default:
		return "Total Annihilation"
	}
}

// PortraitDir is the per-game portrait subdirectory (relative to target).
func (g Game) PortraitDir() string {
	return "img/" + g.Prefix() + "-units"
}
