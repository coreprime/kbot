package studio

import (
	"github.com/coreprime/kbot-engine/games"

	// The shipped games register themselves with the games registry from
	// their package inits; the blank imports make sure both are linked into
	// the studio regardless of what else references them.
	_ "github.com/coreprime/kbot-game-takingdoms/takingdoms"
	_ "github.com/coreprime/kbot-game-totala/totala"
)

// palettes returns the session's game adapter, constructed once from the
// context's game id. This is the single place game identity is consulted;
// everything else — palette resolution, cursor palettes, unit sounds,
// tilesets — talks to the games.Adapter interface.
func (sess *Session) palettes() games.Adapter {
	sess.paletteOnce.Do(func() {
		sess.adapter = games.Resolve(sess.game).NewAdapter(sess.vfs)
	})
	return sess.adapter
}
