// Package common holds the game-data structures shared by Total Annihilation
// and TA:Kingdoms. Each *Base struct collects the fields common to both games'
// version of a schema; the game-specific packages embed the base and add their
// own fields. A matching interface (Feature, Weapon, UnitInfo, GlobalHeader)
// exposes the shared fields as getters so callers can treat either game's value
// uniformly, and the embedding types assert conformance at compile time.
package common

// FeatureBase is the set of feature fields common to TA and TA:Kingdoms
// features/*.tdf entries. Game-specific feature types embed it.
type FeatureBase struct {
	Key string `tdf:",name"` // section header, e.g. GreenAquaOre1

	World       string `tdf:"world,omitempty"`
	Description string `tdf:"description,omitempty"`
	Category    string `tdf:"category,omitempty"`

	FootprintX int `tdf:"footprintx,omitempty"`
	FootprintZ int `tdf:"footprintz,omitempty"`
	Height     int `tdf:"height,omitempty"`

	Animating   int    `tdf:"animating,omitempty"`
	AnimTrans   int    `tdf:"animtrans,omitempty"`
	ShadTrans   int    `tdf:"shadtrans,omitempty"`
	Filename    string `tdf:"filename,omitempty"`
	SeqName     string `tdf:"seqname,omitempty"`
	SeqNameShad string `tdf:"seqnameshad,omitempty"`
	SeqNameDie  string `tdf:"seqnamedie,omitempty"`
	Object      string `tdf:"object,omitempty"`

	HitDensity float64 `tdf:"hitdensity,omitempty"` // Assuming float, due to name/usage
	Metal      float64 `tdf:"metal,omitempty"`      // Assuming float, due to name/usage
	Energy     float64 `tdf:"energy,omitempty"`     // Assuming float, due to name/usage
	Damage     int     `tdf:"damage,omitempty"`

	Blocking       int `tdf:"blocking,omitempty"`
	Reclaimable    int `tdf:"reclaimable,omitempty"`
	Indestructible int `tdf:"indestructible,omitempty"`
	Permanent      int `tdf:"permanent,omitempty"`
	NoDisplayInfo  int `tdf:"nodisplayinfo,omitempty"`

	FeatureReclamate string `tdf:"featurereclamate,omitempty"`
	SeqNameReclamate string `tdf:"seqnamereclamate,omitempty"`
	FeatureDead      string `tdf:"featuredead,omitempty"`

	// Burning.
	Flamable        int    `tdf:"flamable,omitempty"`
	BurnMin         int    `tdf:"burnmin,omitempty"`
	BurnMax         int    `tdf:"burnmax,omitempty"`
	SparkTime       int    `tdf:"sparktime,omitempty"`
	SpreadChance    int    `tdf:"spreadchance,omitempty"`
	BurnWeapon      string `tdf:"burnweapon,omitempty"`
	SeqNameBurn     string `tdf:"seqnameburn,omitempty"`
	SeqNameBurnShad string `tdf:"seqnameburnshad,omitempty"`
	FeatureBurnt    string `tdf:"featureburnt,omitempty"`

	// Reproduction.
	Reproduce     int `tdf:"reproduce,omitempty"`
	ReproduceArea int `tdf:"reproducearea,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Feature is the read interface satisfied by every game's feature type via its
// embedded FeatureBase.
type Feature interface {
	GetKey() string
	GetWorld() string
	GetDescription() string
	GetCategory() string
	GetFootprintX() int
	GetFootprintZ() int
	GetHeight() int
	GetAnimating() int
	GetAnimTrans() int
	GetShadTrans() int
	GetFilename() string
	GetSeqName() string
	GetSeqNameShad() string
	GetSeqNameDie() string
	GetObject() string
	GetHitDensity() float64
	GetMetal() float64
	GetEnergy() float64
	GetDamage() int
	GetBlocking() int
	GetReclaimable() int
	GetIndestructible() int
	GetPermanent() int
	GetNoDisplayInfo() int
	GetFeatureReclamate() string
	GetSeqNameReclamate() string
	GetFeatureDead() string
	GetFlamable() int
	GetBurnMin() int
	GetBurnMax() int
	GetSparkTime() int
	GetSpreadChance() int
	GetBurnWeapon() string
	GetSeqNameBurn() string
	GetSeqNameBurnShad() string
	GetFeatureBurnt() string
	GetReproduce() int
	GetReproduceArea() int
	GetRemaining() map[string]string
}

func (b *FeatureBase) GetKey() string                  { return b.Key }
func (b *FeatureBase) GetWorld() string                { return b.World }
func (b *FeatureBase) GetDescription() string          { return b.Description }
func (b *FeatureBase) GetCategory() string             { return b.Category }
func (b *FeatureBase) GetFootprintX() int              { return b.FootprintX }
func (b *FeatureBase) GetFootprintZ() int              { return b.FootprintZ }
func (b *FeatureBase) GetHeight() int                  { return b.Height }
func (b *FeatureBase) GetAnimating() int               { return b.Animating }
func (b *FeatureBase) GetAnimTrans() int               { return b.AnimTrans }
func (b *FeatureBase) GetShadTrans() int               { return b.ShadTrans }
func (b *FeatureBase) GetFilename() string             { return b.Filename }
func (b *FeatureBase) GetSeqName() string              { return b.SeqName }
func (b *FeatureBase) GetSeqNameShad() string          { return b.SeqNameShad }
func (b *FeatureBase) GetSeqNameDie() string           { return b.SeqNameDie }
func (b *FeatureBase) GetObject() string               { return b.Object }
func (b *FeatureBase) GetHitDensity() float64          { return b.HitDensity }
func (b *FeatureBase) GetMetal() float64               { return b.Metal }
func (b *FeatureBase) GetEnergy() float64              { return b.Energy }
func (b *FeatureBase) GetDamage() int                  { return b.Damage }
func (b *FeatureBase) GetBlocking() int                { return b.Blocking }
func (b *FeatureBase) GetReclaimable() int             { return b.Reclaimable }
func (b *FeatureBase) GetIndestructible() int          { return b.Indestructible }
func (b *FeatureBase) GetPermanent() int               { return b.Permanent }
func (b *FeatureBase) GetNoDisplayInfo() int           { return b.NoDisplayInfo }
func (b *FeatureBase) GetFeatureReclamate() string     { return b.FeatureReclamate }
func (b *FeatureBase) GetSeqNameReclamate() string     { return b.SeqNameReclamate }
func (b *FeatureBase) GetFeatureDead() string          { return b.FeatureDead }
func (b *FeatureBase) GetFlamable() int                { return b.Flamable }
func (b *FeatureBase) GetBurnMin() int                 { return b.BurnMin }
func (b *FeatureBase) GetBurnMax() int                 { return b.BurnMax }
func (b *FeatureBase) GetSparkTime() int               { return b.SparkTime }
func (b *FeatureBase) GetSpreadChance() int            { return b.SpreadChance }
func (b *FeatureBase) GetBurnWeapon() string           { return b.BurnWeapon }
func (b *FeatureBase) GetSeqNameBurn() string          { return b.SeqNameBurn }
func (b *FeatureBase) GetSeqNameBurnShad() string      { return b.SeqNameBurnShad }
func (b *FeatureBase) GetFeatureBurnt() string         { return b.FeatureBurnt }
func (b *FeatureBase) GetReproduce() int               { return b.Reproduce }
func (b *FeatureBase) GetReproduceArea() int           { return b.ReproduceArea }
func (b *FeatureBase) GetRemaining() map[string]string { return b.Remaining }
