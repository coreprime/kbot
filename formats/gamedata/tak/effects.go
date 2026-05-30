package tak

import "github.com/coreprime/kbot/formats/gamedata/common"

// Effect is a top-level particle-effect class from gamedata/effects/effects.tdf
// (e.g. [lightning], [fire]): the canvas size, particle budget and animation
// curve, a [palette] of colour ramps, and an [emitters] block describing how
// particles are spawned.
type Effect struct {
	Key string `tdf:",name"` // section header, e.g. lightning

	Width          int     `tdf:"width,omitempty"`
	Height         int     `tdf:"height,omitempty"`
	AnchorX        int     `tdf:"anchorx,omitempty"`
	AnchorY        int     `tdf:"anchory,omitempty"`
	MaxParticles   int     `tdf:"maxparticles,omitempty"`
	StartIntensity int     `tdf:"startintensity,omitempty"`
	FadeSpeed      float64 `tdf:"fadespeed,omitempty"`
	Rise           int     `tdf:"rise,omitempty"`
	Translucent    int     `tdf:"translucent,omitempty"`

	// Palette holds the colour ramps that tint the particles over their life.
	Palette *EffectPalette `tdf:"palette,omitempty"`

	// Sections preserves the [emitters] block (and any other sub-section) so the
	// file round-trips; emitter shapes vary too much to enumerate field by field.
	Sections []common.Section `tdf:",sections"`

	Remaining map[string]string `tdf:",remaining"`
}

// EffectPalette is the [palette] sub-section of an Effect: an ordered list of
// [ramp] colour gradients.
type EffectPalette struct {
	Key string `tdf:",name"`

	Ramps []Ramp `tdf:"ramp"`

	Remaining map[string]string `tdf:",remaining"`
}

// Ramp is one [ramp] gradient: a start/end palette index paired with a start/end
// RGB colour.
type Ramp struct {
	Key string `tdf:",name"`

	StartIndex int               `tdf:"startindex,omitempty"`
	StartColor *common.RGBString `tdf:"startcolor,omitempty"`
	EndIndex   int               `tdf:"endindex,omitempty"`
	EndColor   *common.RGBString `tdf:"endcolor,omitempty"`

	Remaining map[string]string `tdf:",remaining"`
}
