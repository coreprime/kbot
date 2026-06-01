package gameserver

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tdf"
)

// fbiProvider resolves unit type names against a flattened game-asset tree
// (the unpacked HPI layout: units/*.fbi, weapons/*.tdf). It converts the parsed
// float stats into fixed-point exactly once here, at the asset boundary, so the
// deterministic core only ever sees integers.
type fbiProvider struct {
	root string

	mu      sync.Mutex
	units   map[string]*sim.UnitMeta // lower-cased name -> meta (nil = known-missing)
	weapons map[string]ta.Weapon     // upper-cased section key -> weapon
	loaded  bool
}

// newFBIProvider builds a provider rooted at a flattened asset directory.
func newFBIProvider(root string) *fbiProvider {
	return &fbiProvider{root: root, units: make(map[string]*sim.UnitMeta)}
}

// FBISpawnFunc returns a sim.SpawnFunc backed by the flattened game-asset tree
// at root (units/*.fbi, weapons/*.tdf). It is the asset bridge the native host
// uses to turn Spawn orders into real TA units.
func FBISpawnFunc(root string) sim.SpawnFunc {
	p := newFBIProvider(root)
	return func(name string) (*sim.UnitMeta, sim.Binding) {
		meta, binding, ok := p.Unit(name)
		if !ok {
			return nil, nil
		}
		return meta, binding
	}
}

// FBICobSource returns a CobSource backed by the flattened asset tree's
// scripts/*.cob files, so the native host's authority runs each unit's COB in
// lockstep with the browser clients (which fetch the identical bytes).
func FBICobSource(root string) CobSource {
	p := newFBIProvider(root)
	return func(name string) ([]byte, bool) {
		key := strings.ToLower(strings.TrimSuffix(name, ".cob"))
		path := p.findFile(filepath.Join("scripts", key+".cob"))
		if path == "" {
			return nil, false
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, false
		}
		return b, true
	}
}

// Unit implements assets.Provider.
func (p *fbiProvider) Unit(name string) (*sim.UnitMeta, sim.Binding, bool) {
	key := strings.ToLower(strings.TrimSuffix(name, ".fbi"))
	p.mu.Lock()
	defer p.mu.Unlock()
	if m, ok := p.units[key]; ok {
		return m, nil, m != nil
	}
	meta := p.loadUnit(key)
	p.units[key] = meta
	return meta, nil, meta != nil
}

// loadUnit parses units/<name>.fbi (case-insensitively) and maps it to a meta.
// Returns nil when the file is absent or unparseable. Caller holds p.mu.
func (p *fbiProvider) loadUnit(name string) *sim.UnitMeta {
	path := p.findFile(filepath.Join("units", name+".fbi"))
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var u ta.Unit
	if err := tdf.Unmarshal(data, &u); err != nil {
		return nil
	}
	return p.toMeta(name, &u.Info)
}

// toMeta converts a parsed FBI into the simulation stat block, resolving weapon
// references against this provider's cached weapons index.
func (p *fbiProvider) toMeta(name string, info *ta.UnitInfo) *sim.UnitMeta {
	return MetaFromUnitInfo(name, info, p.resolveWeapon)
}

// resolveWeapon looks up an FBI weapon reference in the cached weapons index.
// Caller holds p.mu (toMeta runs under it).
func (p *fbiProvider) resolveWeapon(ref string) (ta.Weapon, bool) {
	p.ensureWeapons()
	sec, ok := p.weapons[strings.ToUpper(strings.TrimSpace(ref))]
	return sec, ok
}

// MetaFromUnitInfo converts a parsed FBI [UNITINFO] block into the simulation's
// fixed-point stat block. resolveWeapon maps an FBI weapon reference
// (Weapon1/2/3) to its parsed TDF section, returning ok=false for an unknown
// ref. Both asset bridges — the native flattened-tree provider and the studio
// VFS provider — funnel through here so a unit gets identical stats regardless
// of where the bytes were read from.
func MetaFromUnitInfo(name string, info *ta.UnitInfo, resolveWeapon func(ref string) (ta.Weapon, bool)) *sim.UnitMeta {
	m := &sim.UnitMeta{
		Name:        name,
		MaxVelocity: fixed.FromFloat(info.MaxVelocity),
		TurnRate:    fixed.FromInt(info.TurnRate),
		Accel:       fixed.FromFloat(info.Acceleration),
		BrakeRate:   fixed.FromFloat(info.BrakeRate),
		CanMove:     info.MaxVelocity > 0,
		IsBuilder:   info.Builder == 1,
		OnOffable:   info.OnOffable == 1,
	}
	tedClass := strings.ToUpper(strings.TrimSpace(info.TEDClass))
	cats := map[string]bool{}
	for _, c := range info.Category {
		cats[strings.ToUpper(strings.TrimSpace(c))] = true
	}
	switch tedClass {
	case "SHIP":
		m.IsShip = true
	case "SUB", "UWMINE", "UWBLDG":
		m.IsSub = true
	case "VTOL", "FIGHTER", "BOMBER", "GUNSHIP", "TRANSPORT", "AIR":
		m.IsAircraft = true
	}
	if info.CanFly == 1 || cats["VTOL"] || cats["AIR"] || cats["FIGHTER"] || cats["BOMBER"] || cats["GUNSHIP"] {
		m.IsAircraft = true
	}
	if cats["SHIP"] && !m.IsSub {
		m.IsShip = true
	}
	if cats["SUB"] || cats["UNDERWATER"] {
		m.IsSub = true
	}
	m.IsHover = info.HoverAttack == 1
	if m.IsAircraft {
		alt := info.CruiseAlt
		if alt <= 0 {
			if m.IsHover {
				alt = 60
			} else {
				alt = 100
			}
		}
		m.CruiseAltitude = fixed.FromFloat(alt)
	}
	for i, ref := range []string{info.Weapon1, info.Weapon2, info.Weapon3} {
		m.Weapons[i] = weaponMetaFromRef(ref, resolveWeapon)
	}
	return m
}

// weaponMetaFromRef resolves an FBI weapon reference into the engine's per-slot
// stats via the supplied resolver. An empty / NONE / unknown ref yields a zero
// (absent) weapon slot.
func weaponMetaFromRef(ref string, resolveWeapon func(ref string) (ta.Weapon, bool)) sim.WeaponMeta {
	key := strings.ToUpper(strings.TrimSpace(ref))
	if key == "" || key == "NONE" || key == "-" {
		return sim.WeaponMeta{}
	}
	sec, ok := resolveWeapon(key)
	if !ok {
		return sim.WeaponMeta{}
	}
	burst := sec.Burst
	if burst < 1 {
		burst = 1
	}
	return sim.WeaponMeta{
		Name:     key,
		Range:    fixed.FromInt(sec.Range),
		ReloadMs: int(sec.ReloadTime * 1000),
		Burst:    burst,
		Damage:   fixed.FromInt(sec.Damage["default"]),
		Present:  true,

		// Firing arc, in TA-angle units, that gates an aircraft's body before it
		// fires (no rotating turret).
		Tolerance: int32(sec.Tolerance),

		// Projectile flight fields, surfaced from the weapon TDF so a missile /
		// rocket / bomb flies through the projectile subsystem (matching the
		// wasm conversion path in cmd/engine-wasm/convert.go). The TDF turnrate
		// is already in TA-angle units per second.
		Model:           strings.ToLower(strings.TrimSpace(sec.Model)),
		BeamWeapon:      sec.BeamWeapon != 0,
		VelocityWU:      fixed.FromFloat(sec.WeaponVelocity),
		StartVelocityWU: fixed.FromFloat(sec.StartVelocity),
		AccelerationWU:  fixed.FromFloat(sec.WeaponAcceleration),
		TurnRateAng:     int32(sec.TurnRate),
		FlightTimeSec:   fixed.FromFloat(sec.WeaponTimer),
		AreaOfEffectWU:  fixed.FromInt(sec.AreaOfEffect),
		Dropped:         sec.Dropped != 0,
		VLaunch:         sec.VLaunch != 0,
		Tracks:          sec.Tracks != 0,
		SelfProp:        sec.SelfProp != 0,
		Ballistic:       sec.Ballistic != 0,
	}
}

// ensureWeapons walks weapons/*.tdf once and indexes every section by key.
// Caller holds p.mu.
func (p *fbiProvider) ensureWeapons() {
	if p.loaded {
		return
	}
	p.loaded = true
	p.weapons = make(map[string]ta.Weapon)
	dir := p.findFile("weapons")
	if dir == "" {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".tdf") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var weapons []ta.Weapon
		if err := tdf.Unmarshal(data, &weapons); err != nil {
			continue
		}
		for i := range weapons {
			p.weapons[strings.ToUpper(strings.TrimSpace(weapons[i].Key))] = weapons[i]
		}
	}
}

// findFile resolves a path under the asset root case-insensitively, returning
// the real on-disk path or "" when nothing matches.
func (p *fbiProvider) findFile(rel string) string {
	direct := filepath.Join(p.root, rel)
	if _, err := os.Stat(direct); err == nil {
		return direct
	}
	parts := strings.Split(rel, string(filepath.Separator))
	cur := p.root
	for _, want := range parts {
		entries, err := os.ReadDir(cur)
		if err != nil {
			return ""
		}
		next := ""
		for _, e := range entries {
			if strings.EqualFold(e.Name(), want) {
				next = filepath.Join(cur, e.Name())
				break
			}
		}
		if next == "" {
			return ""
		}
		cur = next
	}
	return cur
}
