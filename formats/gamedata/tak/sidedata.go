package tak

import "github.com/coreprime/kbot/formats/gamedata/common"

// Side is a [SIDEn] section of gamedata/sidedata.tdf: the identity, art and
// audio of one playable kingdom (Aramon, Veruna, Taros, Zhon, Creon). Fields
// shared with Total Annihilation live on the embedded common.SideBase.
type Side struct {
	common.SideBase

	God string `tdf:"god,omitempty"`

	Palette      string `tdf:"palette,omitempty"`
	BuildPalette string `tdf:"buildpalette,omitempty"`
	Nimbus       string `tdf:"nimbus,omitempty"`

	BuildSparklyGAF      string `tdf:"buildsparklygaf,omitempty"`
	BuildSparklyAnim     string `tdf:"buildsparklyanim,omitempty"`
	ResurrectSparklyGAF  string `tdf:"resurrectsparklygaf,omitempty"`
	ResurrectSparklyAnim string `tdf:"resurrectsparklyanim,omitempty"`

	LogoGAF   string `tdf:"logogaf,omitempty"`
	LogoArt   string `tdf:"logoart,omitempty"`
	StoneGAF  string `tdf:"stonegaf,omitempty"`
	StoneAnim string `tdf:"stoneanim,omitempty"`

	WaterHeight int `tdf:"waterheight,omitempty"`

	// MusicTracks is a space-separated list of background-music track numbers.
	MusicTracks []int `tdf:"musictracks,omitempty,delimiter=' '"`

	// FogColor is a space-separated "R G B" triple.
	FogColor *common.RGBString `tdf:"fogcolor,omitempty"`

	UnderAttackSound string `tdf:"underattack_sound,omitempty"`
	UnderAttackDelay int    `tdf:"underattack_delay,omitempty"`
}

// Side satisfies the shared common.Side interface via its embedded base.
var _ common.Side = (*Side)(nil)
