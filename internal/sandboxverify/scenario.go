// Package sandboxverify is the headless scenario harness that grades the Go
// sandbox simulation against the canonical engine-mechanics specifications.
// A scenario file declares a tiny world built from real game data (units,
// positions, orders), a run length, and a set of checks: named observables
// sampled at spec-time ticks and compared against hand-derived expected
// values. The harness measures divergence — it never adjusts the sim to pass.
//
// Time axes: scenario ticks are ENGINE frames (the 30 Hz axis every spec
// formula is written against). The sandbox steps at its own sim.TickHz; the
// runner maps each spec tick to the nearest sandbox tick and records the
// residual skew on every sample, so substrate cadence divergence stays
// visible in the report instead of being silently normalised away.
package sandboxverify

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// SpecTickHz is the engine frame rate the specifications (and therefore all
// scenario tick fields and expected values) are expressed against.
const SpecTickHz = 30

// Scenario is one declarative verification case.
type Scenario struct {
	// Name identifies the scenario in reports; file basename by convention.
	Name string `yaml:"name"`
	// Game selects the asset root: "ta" or "tak".
	Game string `yaml:"game"`
	// System buckets the scenario for the gap matrix: locomotion, economy,
	// combat, specials, substrate, world.
	System      string `yaml:"system"`
	Description string `yaml:"description"`
	// Spec cites the specification section(s) the expected values derive from.
	Spec string `yaml:"spec"`
	// Seed feeds both the world RNG and the script runtime.
	Seed uint32 `yaml:"seed"`
	// Duration is the run length in engine frames (30 Hz).
	Duration int `yaml:"duration"`
	// StartMetal / StartEnergy override the TA opening stock per side (the
	// lobby / SkirmishInfo start values). 0 uses the skirmish default (1000).
	// A negative value pins the pool to empty at start (below any storage
	// cap), so income sources become observable instead of overflowing.
	StartMetal  int `yaml:"start_metal"`
	StartEnergy int `yaml:"start_energy"`

	Terrain *TerrainSpec `yaml:"terrain"`
	Units   []UnitSpec   `yaml:"units"`
	Actions []ActionSpec `yaml:"actions"`
	Checks  []CheckSpec  `yaml:"checks"`
}

// TerrainSpec builds a synthetic height field. Omitted = the flat unbounded
// sandbox grid. A ramp rises RampStep height units per cell along RampAxis.
type TerrainSpec struct {
	Width       int     `yaml:"width"`
	Height      int     `yaml:"height"`
	CellWU      int     `yaml:"cell_wu"`      // default 16
	HeightScale float64 `yaml:"height_scale"` // default 0.5 (TA render scale)
	SeaLevel    int     `yaml:"sea_level"`
	RampAxis    string  `yaml:"ramp_axis"` // "x" or "z"; empty = flat
	RampStep    int     `yaml:"ramp_step"` // height units per cell
	BaseHeight  int     `yaml:"base_height"`
	// MetalPatches stamp per-cell metal values into the plot-cell metal field
	// an extractor's placement scan samples (economy.md §1.5 branch 1). Omitted
	// = bare ground (metal byte 0 everywhere).
	MetalPatches []MetalPatch `yaml:"metal_patches"`
}

// MetalPatch fills a rectangle of plot cells (in cell coordinates, 16 wu per
// cell) with a metal byte value.
type MetalPatch struct {
	CellX  int `yaml:"cell_x"`
	CellZ  int `yaml:"cell_z"`
	Width  int `yaml:"width"`
	Height int `yaml:"height"`
	Metal  int `yaml:"metal"`
}

// UnitSpec places one unit at scenario start. Units spawn fully built.
type UnitSpec struct {
	Alias   string `yaml:"alias"`
	Type    string `yaml:"type"`
	Side    int    `yaml:"side"`
	Pos     []int  `yaml:"pos"` // [x, z] in world units
	Heading int    `yaml:"heading"`
}

// ActionSpec issues one order at a spec tick. Kinds the sandbox has no order
// for (a mechanic the sim lacks entirely) are recorded as unsupported and any
// check that requires them grades missing.
type ActionSpec struct {
	At   int    `yaml:"at"` // engine frame
	Do   string `yaml:"do"` // move|stop|attack|fire_at_point|build|repair|stance|set_kills|set_paralyze|cloak|capture|reclaim|self_destruct
	ID   string `yaml:"id"` // optional handle for requires_action
	Unit string `yaml:"unit"`
	// To is the move / fire / build destination in world units.
	To []int `yaml:"to"`
	// Target is the victim alias for attack / capture.
	Target string `yaml:"target"`
	// Slot selects the weapon slot for fire_at_point (0-based).
	Slot int `yaml:"slot"`
	// Build names the unit type a build order raises; Spawns is the alias the
	// resulting buildee is bound to for later checks.
	Build  string `yaml:"build"`
	Spawns string `yaml:"spawns"`
	// Move / Fire set standing orders for a stance action:
	// hold|maneuver|roam and hold|return|fire_at_will.
	Move string `yaml:"move"`
	Fire string `yaml:"fire"`
	// Kills pins the unit's veterancy counters (set_kills action) so the
	// consumer formulas can be graded at an exact level.
	Kills int `yaml:"kills"`
	// Amount is a scalar the measurement-hook actions carry (set_paralyze
	// injects this many paralyze ticks).
	Amount int `yaml:"amount"`
}

// CheckSpec samples one observable at a spec tick and grades it.
type CheckSpec struct {
	At         int    `yaml:"at"` // engine frame at which to sample
	Label      string `yaml:"label"`
	Unit       string `yaml:"unit"` // alias for unit.* observables
	Side       *int   `yaml:"side"` // side index for side.* observables
	Observable string `yaml:"observable"`
	Expect     int64  `yaml:"expect"`
	// Baseline is subtracted from the sample before comparison, turning an
	// absolute observable into an effect measurement (e.g. pool movement
	// from the shared 1000-stock start). With MissingIfZero a zero effect
	// grades missing — the mechanic never acted at all.
	Baseline int64 `yaml:"baseline"`
	// Derivation is the auditable hand computation of Expect from the spec
	// formula — required on every check.
	Derivation string `yaml:"derivation"`
	// MissingIfZero grades a zero actual (with nonzero expectation) as
	// "missing": the mechanic produced no effect at all, as opposed to a
	// wrong value from an existing mechanic.
	MissingIfZero bool `yaml:"missing_if_zero"`
	// Cosmetic marks divergence the spec calls render-only; mismatches grade
	// cosmetic-gap instead of wrong.
	Cosmetic bool `yaml:"cosmetic"`
	// RequiresAction names an ActionSpec ID; if that action was unsupported
	// by the sim the check grades missing without sampling.
	RequiresAction string `yaml:"requires_action"`
	// Args carries scalar parameters for the parametric observables that need
	// values a plain unit/side sample can't supply: unit.coverage_covers reads
	// [x, z] (world units) to probe an interceptor's square coverage box;
	// unit.resurrect_ticks reads [targetBuildTime] to compute the resurrect
	// channel length against that buildtime.
	Args []int `yaml:"args"`
}

// Load reads one scenario file.
func Load(path string) (*Scenario, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Scenario
	if err := yaml.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if s.Name == "" {
		s.Name = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	if err := s.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return &s, nil
}

// LoadDir reads every *.yaml scenario under dir, sorted by name.
func LoadDir(dir string) ([]*Scenario, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []*Scenario
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".yaml") {
			continue
		}
		s, err := Load(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Scenario) validate() error {
	if s.Game != "ta" && s.Game != "tak" {
		return fmt.Errorf("game must be ta or tak, got %q", s.Game)
	}
	if s.Duration <= 0 {
		return fmt.Errorf("duration must be positive")
	}
	aliases := map[string]bool{}
	for i, u := range s.Units {
		if u.Alias == "" || u.Type == "" {
			return fmt.Errorf("unit %d needs alias and type", i)
		}
		if len(u.Pos) != 2 {
			return fmt.Errorf("unit %s: pos must be [x, z]", u.Alias)
		}
		if aliases[u.Alias] {
			return fmt.Errorf("duplicate alias %s", u.Alias)
		}
		aliases[u.Alias] = true
	}
	ids := map[string]bool{}
	for i, a := range s.Actions {
		if a.Do == "" {
			return fmt.Errorf("action %d needs do", i)
		}
		if a.ID != "" {
			if ids[a.ID] {
				return fmt.Errorf("duplicate action id %s", a.ID)
			}
			ids[a.ID] = true
		}
		if a.Spawns != "" {
			if aliases[a.Spawns] {
				return fmt.Errorf("action %d: spawns alias %s already used", i, a.Spawns)
			}
			aliases[a.Spawns] = true
		}
	}
	for i, c := range s.Checks {
		if c.Observable == "" {
			return fmt.Errorf("check %d needs observable", i)
		}
		if c.Derivation == "" {
			return fmt.Errorf("check %d (%s): derivation is required", i, c.Label)
		}
		if c.RequiresAction != "" && !ids[c.RequiresAction] {
			return fmt.Errorf("check %d references unknown action id %s", i, c.RequiresAction)
		}
	}
	return nil
}
