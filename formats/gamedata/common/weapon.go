package common

// WeaponBase is the set of weapon fields common to TA and TA:Kingdoms. The
// per-target Damage map differs in element type between the games (TA uses
// integer points, TA:Kingdoms uses fractional multipliers) and so stays on the
// game-specific type rather than the base.
type WeaponBase struct {
	Key string `tdf:",name"` // section header, e.g. FLAMETHROWER or WEAPON1

	Name              string  `tdf:"name,omitempty"`
	Range             int     `tdf:"range,omitempty"`
	ReloadTime        float64 `tdf:"reloadtime,omitempty"`
	WeaponVelocity    float64 `tdf:"weaponvelocity,omitempty"` // Assuming float, due to name/usage
	AreaOfEffect      int     `tdf:"areaofeffect,omitempty"`
	EdgeEffectiveness float64 `tdf:"edgeeffectiveness,omitempty"`
	FireStarter       float64 `tdf:"firestarter,omitempty"` // Assuming float, due to percentage usage
	TurnRate          int     `tdf:"turnrate,omitempty"`
	Model             string  `tdf:"model,omitempty"`
	SoundHit          string  `tdf:"soundhit,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Weapon is the read interface satisfied by every game's weapon type via its
// embedded WeaponBase.
type Weapon interface {
	GetKey() string
	GetName() string
	GetRange() int
	GetReloadTime() float64
	GetWeaponVelocity() float64
	GetAreaOfEffect() int
	GetEdgeEffectiveness() float64
	GetFireStarter() float64
	GetTurnRate() int
	GetModel() string
	GetSoundHit() string
	GetRemaining() map[string]string
}

func (b *WeaponBase) GetKey() string                  { return b.Key }
func (b *WeaponBase) GetName() string                 { return b.Name }
func (b *WeaponBase) GetRange() int                   { return b.Range }
func (b *WeaponBase) GetReloadTime() float64          { return b.ReloadTime }
func (b *WeaponBase) GetWeaponVelocity() float64      { return b.WeaponVelocity }
func (b *WeaponBase) GetAreaOfEffect() int            { return b.AreaOfEffect }
func (b *WeaponBase) GetEdgeEffectiveness() float64   { return b.EdgeEffectiveness }
func (b *WeaponBase) GetFireStarter() float64         { return b.FireStarter }
func (b *WeaponBase) GetTurnRate() int                { return b.TurnRate }
func (b *WeaponBase) GetModel() string                { return b.Model }
func (b *WeaponBase) GetSoundHit() string             { return b.SoundHit }
func (b *WeaponBase) GetRemaining() map[string]string { return b.Remaining }
