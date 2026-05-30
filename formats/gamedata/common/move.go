package common

// MovementClassBase is the set of movement-class fields common to TA and
// TA:Kingdoms. A moveinfo.tdf file is a document of sibling [CLASSn] sections,
// each describing a terrain-traversal profile that units reference by Name.
// Fields unique to one game live on that game's MovementClass type.
type MovementClassBase struct {
	Key string `tdf:",name"` // section header, e.g. CLASS0

	Name          string `tdf:"name,omitempty"`
	FootprintX    int    `tdf:"footprintx,omitempty"`
	FootprintZ    int    `tdf:"footprintz,omitempty"`
	MinWaterDepth int    `tdf:"minwaterdepth,omitempty"`
	MaxWaterDepth int    `tdf:"maxwaterdepth,omitempty"`
	MaxSlope      int    `tdf:"maxslope,omitempty"`
	MaxWaterSlope int    `tdf:"maxwaterslope,omitempty"`
	BadSlope      int    `tdf:"badslope,omitempty"`
	BadWaterSlope int    `tdf:"badwaterslope,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// MovementClass is the read interface satisfied by every game's movement-class
// type via its embedded MovementClassBase.
type MovementClass interface {
	GetKey() string
	GetName() string
	GetFootprintX() int
	GetFootprintZ() int
	GetMinWaterDepth() int
	GetMaxWaterDepth() int
	GetMaxSlope() int
	GetMaxWaterSlope() int
	GetBadSlope() int
	GetBadWaterSlope() int
	GetRemaining() map[string]string
}

func (b *MovementClassBase) GetKey() string                  { return b.Key }
func (b *MovementClassBase) GetName() string                 { return b.Name }
func (b *MovementClassBase) GetFootprintX() int              { return b.FootprintX }
func (b *MovementClassBase) GetFootprintZ() int              { return b.FootprintZ }
func (b *MovementClassBase) GetMinWaterDepth() int           { return b.MinWaterDepth }
func (b *MovementClassBase) GetMaxWaterDepth() int           { return b.MaxWaterDepth }
func (b *MovementClassBase) GetMaxSlope() int                { return b.MaxSlope }
func (b *MovementClassBase) GetMaxWaterSlope() int           { return b.MaxWaterSlope }
func (b *MovementClassBase) GetBadSlope() int                { return b.BadSlope }
func (b *MovementClassBase) GetBadWaterSlope() int           { return b.BadWaterSlope }
func (b *MovementClassBase) GetRemaining() map[string]string { return b.Remaining }
