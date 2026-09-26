package studio

import (
	"github.com/coreprime/kbot-engine/games"
	"github.com/coreprime/kbot-io/formats/gaf"
)

// takingdomsID is the games-registry id of TA: Kingdoms.
const takingdomsID = "takingdoms"

// isKingdoms reports whether the session's game is TA: Kingdoms. Unknown
// game ids resolve to Total Annihilation, as games.Resolve does.
func (sess *Session) isKingdoms() bool {
	return games.Resolve(sess.game).ID() == takingdomsID
}

// gafVariant is the GAF colouring variant of the session's game.
func (sess *Session) gafVariant() gaf.Variant {
	if sess.isKingdoms() {
		return gaf.VariantTAK
	}
	return gaf.VariantTA
}

// spriteRenderOptions returns how the studio draws sprite GAF frames
// (features, cursors, weapon bitmaps, load screens). For TA this is the
// game's rule: a raw frame's pixels equal to its key and a compressed
// frame's skipped pixels are transparent, and palette index 0 is opaque
// black. TA: Kingdoms raw atlases often store a key that differs from their
// background, so for TA: Kingdoms the corner guess is applied to raw frames.
func (sess *Session) spriteRenderOptions() gaf.RenderOptions {
	return sess.gafVariant().DefaultRenderOptions()
}
