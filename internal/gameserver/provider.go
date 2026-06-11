package gameserver

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/games"
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
	m, err := games.UnitMetaFromFBI(name, data, p.resolveWeapon)
	if err != nil {
		return nil
	}
	return m
}

// resolveWeapon looks up an FBI weapon reference in the cached weapons index.
// Caller holds p.mu (toMeta runs under it).
func (p *fbiProvider) resolveWeapon(ref string) (ta.Weapon, bool) {
	p.ensureWeapons()
	sec, ok := p.weapons[strings.ToUpper(strings.TrimSpace(ref))]
	return sec, ok
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
