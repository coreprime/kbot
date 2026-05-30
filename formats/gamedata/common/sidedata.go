package common

// SideBase is the set of [SIDEn] fields common to TA and TA:Kingdoms
// gamedata/sidedata.tdf entries: the playable side's display identity.
// Game-specific Side types embed it and add their own art, audio and HUD fields.
type SideBase struct {
	Key string `tdf:",name"` // section header, e.g. SIDE0

	Name       string `tdf:"name,omitempty"`
	NamePrefix string `tdf:"nameprefix,omitempty"`
	Commander  string `tdf:"commander,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Side is the read interface satisfied by every game's side type via its
// embedded SideBase.
type Side interface {
	GetKey() string
	GetName() string
	GetNamePrefix() string
	GetCommander() string
	GetRemaining() map[string]string
}

func (b *SideBase) GetKey() string                  { return b.Key }
func (b *SideBase) GetName() string                 { return b.Name }
func (b *SideBase) GetNamePrefix() string           { return b.NamePrefix }
func (b *SideBase) GetCommander() string            { return b.Commander }
func (b *SideBase) GetRemaining() map[string]string { return b.Remaining }
