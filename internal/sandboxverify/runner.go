package sandboxverify

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/frame"
	"github.com/coreprime/kbot-engine/engine/order"
	"github.com/coreprime/kbot-engine/engine/script"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/scripting"
	"github.com/coreprime/kbot-io/formats/tdf"
	"github.com/coreprime/kbot-engine/games"
)

// Runner grades scenarios against a live sandbox world built from the real
// flattened game installs.
type Runner struct {
	TARoot  string
	TAKRoot string
}

// Run executes every scenario and assembles the report.
func (r *Runner) Run(scenarios []*Scenario) *Report {
	rep := &Report{
		SpecTickHz: SpecTickHz,
		SimTickHz:  sim.TickHz,
		TARoot:     r.TARoot,
		TAKRoot:    r.TAKRoot,
	}
	for _, sc := range scenarios {
		rep.Scenarios = append(rep.Scenarios, r.runOne(sc))
	}
	rep.Matrix = BuildMatrix(rep.Scenarios)
	return rep
}

// specToSimTick maps an engine frame (30 Hz) onto the sandbox tick axis.
// Since the substrate transplant the sandbox ticks at the engines' 30 Hz, so
// the mapping is 1:1 (the rounding survives as a guard should the rates ever
// diverge again).
func specToSimTick(specTick int) uint64 {
	return uint64(math.Round(float64(specTick) * float64(sim.TickHz) / float64(SpecTickHz)))
}

// skewMs is the wall-clock misalignment between a spec tick and the sandbox
// tick it was sampled at — the substrate cadence residue. Zero everywhere on
// the aligned 30 Hz axis.
func skewMs(specTick int, simTick uint64) int64 {
	specMs := int64(specTick) * 1000 / SpecTickHz
	simMs := int64(simTick) * 1000 / int64(sim.TickHz)
	return simMs - specMs
}

// run state for one scenario.
type runState struct {
	world   *sim.World
	rt      *script.Runtime
	aliases map[string]uint32 // alias -> unit id
	metas   map[string]*sim.UnitMeta
	// pendingSpawns maps a buildee type name (lower-cased) to the alias the
	// next spawned unit of that type binds to.
	pendingSpawns map[string]string
	// unsupported records action IDs the sim had no order kind for.
	unsupported map[string]string // id -> reason
	fireCounts  map[uint32]int64
	projSpawns  map[uint32]int64
	startPos    map[uint32]fixed.Vec3
	rngStart    uint64
	rngNow      uint64
	lastSnap    frame.Snapshot
	seenUnits   map[uint32]bool
}

func (r *Runner) runOne(sc *Scenario) ScenarioResult {
	res := ScenarioResult{
		Name:        sc.Name,
		Game:        sc.Game,
		System:      sc.System,
		Description: sc.Description,
		Spec:        sc.Spec,
	}
	root := r.TARoot
	if sc.Game == "tak" {
		root = r.TAKRoot
	}
	if root == "" {
		res.Error = fmt.Sprintf("no asset root configured for game %q", sc.Game)
		return res
	}
	st, err := buildWorld(sc, root)
	if err != nil {
		res.Error = err.Error()
		return res
	}

	// Group actions and checks by sandbox tick.
	actionsAt := map[uint64][]ActionSpec{}
	for _, a := range sc.Actions {
		t := specToSimTick(a.At)
		actionsAt[t] = append(actionsAt[t], a)
	}
	checksAt := map[uint64][]int{}
	maxTick := specToSimTick(sc.Duration)
	for i, c := range sc.Checks {
		t := specToSimTick(c.At)
		if t > maxTick {
			maxTick = t
		}
		checksAt[t] = append(checksAt[t], i)
	}
	results := make([]CheckResult, len(sc.Checks))

	sample := func(tick uint64) {
		for _, idx := range checksAt[tick] {
			c := sc.Checks[idx]
			results[idx] = st.evaluate(sc, c, tick)
		}
	}

	// Tick 0 actions/checks run against the pristine world.
	st.observe()
	for _, a := range actionsAt[0] {
		st.apply(a)
	}
	sample(0)
	for tick := uint64(1); tick <= maxTick; tick++ {
		if acts, ok := actionsAt[tick]; ok {
			for _, a := range acts {
				st.apply(a)
			}
		}
		st.world.Step(st.rt)
		st.observe()
		sample(tick)
	}
	res.Checks = results
	return res
}

// buildWorld loads scenario units from the flattened install and constructs
// the world exactly the way the native sandbox authority does: meta via
// games.UnitMetaFromFBI (weapons resolved from weapons/*.tdf), binding from
// the retail COB run by a per-scenario script runtime.
func buildWorld(sc *Scenario, root string) (*runState, error) {
	weapons, err := loadWeaponIndex(root)
	if err != nil {
		return nil, err
	}
	moveClasses := loadMoveClasses(root)
	rt := script.NewRuntime(sc.Seed)
	metas := map[string]*sim.UnitMeta{}
	programs := map[string]*script.Program{}
	resolve := func(ref string) (ta.Weapon, bool) {
		sec, ok := weapons[strings.ToUpper(strings.TrimSpace(ref))]
		return sec, ok
	}
	loadType := func(name string) (*sim.UnitMeta, sim.Binding, error) {
		key := strings.ToLower(name)
		fbiPath, err := findFile(root, filepath.Join("units", key+".fbi"))
		if err != nil {
			return nil, nil, fmt.Errorf("unit %s: %w", name, err)
		}
		fbi, err := os.ReadFile(fbiPath)
		if err != nil {
			return nil, nil, err
		}
		meta, ok := metas[key]
		if !ok {
			meta, err = games.UnitMetaFromFBI(key, fbi, resolve)
			if err != nil {
				return nil, nil, fmt.Errorf("unit %s: %w", name, err)
			}
			// The moveinfo.tdf class replaces the FBI's footprint and
			// water/slope limits when the unit names one — exactly the way
			// both engines resolve movement classes at load.
			games.ApplyMovementClass(meta, moveClasses)
			// Exact-combat fields: [DAMAGE] tables, tick-domain reload,
			// spray/accuracy, behavior classes, death blasts.
			games.EnrichCombatMeta(meta, fbi, resolve)
			metas[key] = meta
		}
		prog, ok := programs[key]
		if !ok {
			prog = loadProgram(root, key)
			programs[key] = prog
		}
		if prog == nil {
			return meta, nil, nil
		}
		return meta, rt.NewUnit(prog, nil), nil
	}
	spawn := func(name string) (*sim.UnitMeta, sim.Binding) {
		meta, binding, err := loadType(name)
		if err != nil {
			return nil, nil
		}
		return meta, binding
	}
	// Share the script runtime's MINSTD stream with the world — one sim
	// stream for COB RAND and world draws, the engines' discipline — so the
	// rng_draws observable counts total sim-stream consumption.
	econ := sim.EconomyTA
	if sc.Game == "tak" {
		econ = sim.EconomyTAK
	}
	// A scenario declares its opening stock explicitly. Zero keeps the
	// skirmish default (1000); a negative request maps to an exact 0 stock
	// (income sources then accumulate visibly rather than overflowing).
	startM, startE := sc.StartMetal, sc.StartEnergy
	if startM < 0 {
		startM = -1
	}
	if startE < 0 {
		startE = -1
	}
	w := sim.New(sim.Config{
		Seed: sc.Seed, Spawn: spawn, Rand: rt.Rand(), Economy: econ,
		StartMetal: startM, StartEnergy: startE,
	})
	if t := makeTerrain(sc.Terrain); t != nil {
		w.SetTerrain(t)
	}
	st := &runState{
		world:         w,
		rt:            rt,
		aliases:       map[string]uint32{},
		metas:         metas,
		pendingSpawns: map[string]string{},
		unsupported:   map[string]string{},
		fireCounts:    map[uint32]int64{},
		projSpawns:    map[uint32]int64{},
		startPos:      map[uint32]fixed.Vec3{},
		seenUnits:     map[uint32]bool{},
	}
	// Sample the draw baseline BEFORE the scenario units spawn: unit
	// initialisation itself consumes sim-stream draws in the engines, and
	// the rng_draws observable is meant to see them.
	st.rngStart = w.RngDraws()
	st.rngNow = st.rngStart
	for _, u := range sc.Units {
		meta, binding, err := loadType(u.Type)
		if err != nil {
			return nil, err
		}
		id := w.AddUnit(strings.ToLower(u.Type), meta, binding,
			fixed.Vec2{X: fixed.FromInt(u.Pos[0]), Z: fixed.FromInt(u.Pos[1])},
			int32(u.Heading), u.Side)
		st.aliases[u.Alias] = id
		st.seenUnits[id] = true
		if unit := w.UnitByID(id); unit != nil {
			st.startPos[id] = unit.Pos()
		}
	}
	return st, nil
}

// apply issues one scenario action; unknown/unimplementable kinds are
// recorded so dependent checks grade missing.
func (st *runState) apply(a ActionSpec) {
	unit := st.aliases[a.Unit]
	target := st.aliases[a.Target]
	switch a.Do {
	case "move":
		st.world.ApplyOrder(order.Move([]uint32{unit}, vec2(a.To)))
	case "stop":
		st.world.ApplyOrder(order.Stop([]uint32{unit}))
	case "attack":
		st.world.ApplyOrder(order.Attack([]uint32{unit}, target))
	case "fire_at_point":
		st.world.ApplyOrder(order.FireAtPoint(unit, a.Slot, vec2(a.To)))
	case "build":
		st.world.ApplyOrder(order.Build(unit, strings.ToLower(a.Build), vec2(a.To), 0))
		if a.Spawns != "" {
			st.pendingSpawns[strings.ToLower(a.Build)] = a.Spawns
		}
	case "repair":
		// Repair/assist resumes an existing under-construction frame (the
		// Target alias) — the engines' assist path: additive, uncapped, each
		// assister running its own applicator into the shared buildee.
		st.world.ApplyOrder(order.Repair(unit, target))
	case "set_kills":
		// Measurement hook: pin the veterancy counters so consumer math can
		// be graded at an exact level without staging real kills first.
		st.world.SetUnitKills(unit, a.Kills)
	case "stance":
		mv, okM := map[string]int{"hold": order.MoveHold, "maneuver": order.MoveManeuver, "roam": order.MoveRoam}[a.Move]
		fr, okF := map[string]int{"hold": order.FireHold, "return": order.FireReturn, "fire_at_will": order.FireAtWill}[a.Fire]
		if !okM || !okF {
			st.markUnsupported(a, fmt.Sprintf("unknown stance %q/%q", a.Move, a.Fire))
			return
		}
		st.world.ApplyOrder(order.Stance([]uint32{unit}, mv, fr))
	case "set_paralyze":
		// Measurement hook: inject paralyze ticks directly so the accumulator
		// cap (1800) and decay grade on the mechanic's own math, free of the
		// paralyzer firing chain's aim/reload/flight variables.
		st.world.InjectParalyze(unit, a.Amount)
	case "set_health":
		// Measurement hook: pin a unit's health-bar percent (Amount) so a
		// heal mechanic's restoration is observable from a known deficit.
		st.world.SetHealthPercent(unit, a.Amount)
	case "capture":
		st.world.ApplyOrder(order.Capture([]uint32{unit}, target))
	case "reclaim":
		st.world.ApplyOrder(order.Reclaim([]uint32{unit}, target))
	case "cloak":
		st.world.ApplyOrder(order.Cloak([]uint32{unit}))
	case "self_destruct":
		st.world.ApplyOrder(order.SelfDestruct([]uint32{unit}))
	default:
		// The order vocabulary has no such command — the mechanic is absent
		// from the sandbox (cloak, capture, ...). That absence is the finding.
		st.markUnsupported(a, fmt.Sprintf("sim has no %q order kind", a.Do))
	}
}

func (st *runState) markUnsupported(a ActionSpec, reason string) {
	id := a.ID
	if id == "" {
		id = a.Do
	}
	st.unsupported[id] = reason
}

// observe pulls the post-step snapshot, folding events into cumulative
// counters and binding freshly spawned buildees to their declared aliases.
func (st *runState) observe() {
	snap := st.world.Snapshot()
	st.lastSnap = snap
	st.rngNow = st.world.RngDraws()
	for _, e := range snap.Events {
		switch e.Kind {
		case frame.EvFire:
			st.fireCounts[e.UnitID]++
		case frame.EvProjectileSpawn:
			st.projSpawns[e.UnitID]++
		}
	}
	for i := range snap.Units {
		u := &snap.Units[i]
		if st.seenUnits[u.ID] {
			continue
		}
		st.seenUnits[u.ID] = true
		st.startPos[u.ID] = u.Pos
		if alias, ok := st.pendingSpawns[u.Name]; ok {
			st.aliases[alias] = u.ID
			delete(st.pendingSpawns, u.Name)
		}
	}
}

func vec2(to []int) fixed.Vec2 {
	var v fixed.Vec2
	if len(to) == 2 {
		v = fixed.Vec2{X: fixed.FromInt(to[0]), Z: fixed.FromInt(to[1])}
	}
	return v
}

// loadWeaponIndex walks weapons/*.tdf once (TA installs; TA:K units carry
// their weapons inline so an absent directory is fine).
func loadWeaponIndex(root string) (map[string]ta.Weapon, error) {
	out := map[string]ta.Weapon{}
	dir, err := findFile(root, "weapons")
	if err != nil {
		return out, nil // no weapons directory: inline-weapon game
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".tdf") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var ws []ta.Weapon
		if err := tdf.Unmarshal(data, &ws); err != nil {
			continue
		}
		for i := range ws {
			out[strings.ToUpper(strings.TrimSpace(ws[i].Key))] = ws[i]
		}
	}
	return out, nil
}

// loadMoveClasses parses gamedata/moveinfo.tdf under the root; nil (no class
// resolution) when the game ships none.
func loadMoveClasses(root string) games.MovementClasses {
	path, err := findFile(root, filepath.Join("gamedata", "moveinfo.tdf"))
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	classes, err := games.LoadMovementClasses(data)
	if err != nil {
		return nil
	}
	return classes
}

// loadProgram compiles scripts/<name>.cob into a runnable program, nil when
// the type ships no script (script-less units still simulate).
func loadProgram(root, name string) *script.Program {
	path, err := findFile(root, filepath.Join("scripts", name+".cob"))
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		return nil
	}
	return prog
}

// findFile resolves rel under root case-insensitively.
func findFile(root, rel string) (string, error) {
	direct := filepath.Join(root, rel)
	if _, err := os.Stat(direct); err == nil {
		return direct, nil
	}
	cur := root
	for _, want := range strings.Split(rel, string(filepath.Separator)) {
		entries, err := os.ReadDir(cur)
		if err != nil {
			return "", err
		}
		next := ""
		for _, e := range entries {
			if strings.EqualFold(e.Name(), want) {
				next = filepath.Join(cur, e.Name())
				break
			}
		}
		if next == "" {
			return "", fmt.Errorf("%s not found under %s", rel, root)
		}
		cur = next
	}
	return cur, nil
}

// makeTerrain builds the synthetic height field a scenario declares.
func makeTerrain(ts *TerrainSpec) *sim.Terrain {
	if ts == nil {
		return nil
	}
	w, h := ts.Width, ts.Height
	if w <= 0 || h <= 0 {
		return nil
	}
	cell := ts.CellWU
	if cell <= 0 {
		cell = 16
	}
	scale := ts.HeightScale
	if scale == 0 {
		scale = 0.5
	}
	data := make([]uint8, w*h)
	for z := 0; z < h; z++ {
		for x := 0; x < w; x++ {
			v := ts.BaseHeight
			switch ts.RampAxis {
			case "x":
				v += ts.RampStep * x
			case "z":
				v += ts.RampStep * z
			}
			if v < 0 {
				v = 0
			}
			if v > 255 {
				v = 255
			}
			data[z*w+x] = uint8(v)
		}
	}
	var metal []uint8
	if len(ts.MetalPatches) > 0 {
		metal = make([]uint8, w*h)
		for _, p := range ts.MetalPatches {
			for dz := 0; dz < p.Height; dz++ {
				for dx := 0; dx < p.Width; dx++ {
					cx, cz := p.CellX+dx, p.CellZ+dz
					if cx < 0 || cz < 0 || cx >= w || cz >= h {
						continue
					}
					v := p.Metal
					if v < 0 {
						v = 0
					}
					if v > 255 {
						v = 255
					}
					metal[cz*w+cx] = uint8(v)
				}
			}
		}
	}
	return &sim.Terrain{
		W:           w,
		H:           h,
		CellWU:      fixed.FromInt(cell),
		HeightScale: fixed.FromFloat(scale),
		SeaLevel:    ts.SeaLevel,
		Data:        data,
		Metal:       metal,
	}
}
