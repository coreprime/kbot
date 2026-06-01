package assetrender

import (
	"bytes"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/coreprime/kbot/formats/ai"
	"github.com/coreprime/kbot/formats/crt"
	"github.com/coreprime/kbot/formats/fnt"
	"github.com/coreprime/kbot/formats/hpi"
	"github.com/coreprime/kbot/formats/objects3d"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/formats/scripting/compiler"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/formats/scripting/linter"
	"github.com/coreprime/kbot/formats/scripting/parser"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
)

// init registers the heavier structured / script-analysis describers. Keeping
// them out of describe.go's literal lets the simple formats and the rich ones
// evolve independently.
func init() {
	for ext, d := range map[string]describer{
		".cob": describeCOB,
		".bos": describeBOS,
		".h":   describeBOS,
		".crt": describeCRT,
		".3do": describe3DO,
		".hpi": describeHPI,
		".ufo": describeHPI,
		".ccx": describeHPI,
		".gp3": describeHPI,
		".fnt": describeFNT,
		".pal": describePAL,
		".sct": describeSCT,
		".tnt": describeTNT,
		".ai":  describeAI,
	} {
		describers[ext] = d
	}
}

// lintDiag is the JSON shape the UI's Lint tab consumes for COB/BOS files.
type lintDiag struct {
	Line     int    `json:"line"`
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Script   string `json:"script"`
	Message  string `json:"message"`
}

func diagsToJSON(diags []linter.Diagnostic) ([]lintDiag, map[string]int) {
	out := make([]lintDiag, 0, len(diags))
	summary := map[string]int{}
	for _, d := range diags {
		out = append(out, lintDiag{
			Line:     d.Line,
			Rule:     d.Rule,
			Severity: d.Severity.String(),
			Script:   d.Script,
			Message:  d.Message,
		})
		summary[d.Rule]++
	}
	return out, summary
}

func describeCOB(_ *Renderer, _ string, data []byte, out map[string]any) {
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	out["format"] = "COB"
	out["version"] = cob.VersionSignature
	out["scriptCount"] = cob.NumScripts
	out["pieceCount"] = cob.NumPieces
	out["codeLength"] = len(cob.Code)
	out["staticVars"] = cob.NumberOfStaticVars
	out["scriptNames"] = cob.ScriptNames
	out["pieceNames"] = cob.PieceNames

	if disasm, err := decompiler.NewDecompiler(cob).Disassemble(assembly.Plain); err == nil {
		out["disassembly"] = disasm
	}
	// The decompiler mutates COB state, so re-load for the high-level pass.
	if cob2, err := scripting.LoadFromReader(bytes.NewReader(data)); err == nil {
		if decompiled, err := decompiler.NewDecompiler(cob2).Decompile(); err == nil {
			out["decompiled"] = decompiled
		}
	}
	// Call graph (functions, signals, and the edges between them) drives the
	// flow-arrow and graph views; analysis runs on a fresh load.
	if cob5, err := scripting.LoadFromReader(bytes.NewReader(data)); err == nil {
		graph := linter.New().GetCallGraph(cob5)
		if graph != nil && len(graph.Nodes) > 0 {
			out["callGraphNodes"] = graph.Nodes
			out["callGraphEdges"] = graph.Edges
		}
	}
	// Web disassembly: a structured JSON form of the bytecode the code view can
	// fold, annotate, and draw control-flow arrows over.
	if cob6, err := scripting.LoadFromReader(bytes.NewReader(data)); err == nil {
		if webDisasm, err := assembly.GenerateWebDisassembly(cob6); err == nil {
			out["webDisassembly"] = webDisasm
		}
	}
	if cob3, err := scripting.LoadFromReader(bytes.NewReader(data)); err == nil {
		results, summary := diagsToJSON(linter.New().Lint(cob3))
		out["lintResults"] = results
		out["lintSummary"] = summary
	}
}

// describeAI parses a TA / TA: Kingdoms bot profile into its per-difficulty
// plans (unit weights and build limits) for the AI plan view.
func describeAI(_ *Renderer, _ string, data []byte, out map[string]any) {
	aiFile, err := ai.Parse(data)
	if err != nil {
		return
	}
	out["format"] = "AI Profile"

	type weight struct {
		Unit   string  `json:"unit"`
		Weight float64 `json:"weight"`
	}
	type limit struct {
		Unit    string `json:"unit"`
		Maximum int    `json:"maximum"`
	}
	type plan struct {
		Name    string   `json:"name"`
		Weights []weight `json:"weights"`
		Limits  []limit  `json:"limits"`
	}

	plans := make([]plan, 0, len(aiFile.Plans))
	for _, p := range aiFile.Plans {
		pl := plan{Name: p.Name, Weights: make([]weight, 0, len(p.Weights)), Limits: make([]limit, 0, len(p.Limits))}
		for _, w := range p.Weights {
			pl.Weights = append(pl.Weights, weight{Unit: w.UnitName, Weight: w.Weight})
		}
		for _, l := range p.Limits {
			pl.Limits = append(pl.Limits, limit{Unit: l.UnitName, Maximum: l.Maximum})
		}
		plans = append(plans, pl)
	}
	out["aiPlans"] = plans
}

func describeBOS(r *Renderer, vpath string, data []byte, out map[string]any) {
	if !isProbablyText(data) {
		return
	}
	out["format"] = "BOS Script"
	if strings.EqualFold(path.Ext(vpath), ".h") {
		out["format"] = "BOS Header"
	}

	lines := bytes.Split(data, []byte{'\n'})
	code, comments := 0, 0
	for _, line := range lines {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			continue
		}
		if bytes.HasPrefix(trimmed, []byte("//")) {
			comments++
		} else {
			code++
		}
	}
	out["totalLines"] = len(lines)
	out["codeLines"] = code
	out["commentLines"] = comments

	// Lint .bos files by resolving #includes through the VFS, compiling, then
	// linting the result. Headers (.h) are not standalone compilation units.
	if strings.EqualFold(path.Ext(vpath), ".bos") {
		describeBOSCallGraph(r, vpath, data, out)

		if r.vfs == nil {
			return
		}
		prep := parser.NewPreprocessor(r.vfs, path.Dir(vpath), "")
		processed, err := prep.ProcessContent(string(data), vpath)
		if err != nil {
			out["lintError"] = fmt.Sprintf("preprocessing failed: %v", err)
			return
		}
		cob, err := compiler.NewCompiler(processed).Compile()
		if err != nil {
			out["lintError"] = fmt.Sprintf("compilation failed: %v", err)
			return
		}
		results, summary := diagsToJSON(linter.New().Lint(cob))
		out["lintResults"] = results
		out["lintSummary"] = summary
	}
}

// describeBOSCallGraph extracts a BOS file's call/signal graph. It prefers a
// full compile (which yields accurate edges), preprocessing #includes through
// the VFS first when available, and falls back to a text scan for files that
// don't compile cleanly on their own.
func describeBOSCallGraph(r *Renderer, vpath string, data []byte, out map[string]any) {
	source := string(data)
	if r.vfs != nil {
		prep := parser.NewPreprocessor(r.vfs, path.Dir(vpath), "")
		if processed, err := prep.ProcessContent(source, vpath); err == nil {
			source = processed
		}
	}

	if cob, err := compiler.NewCompiler(source).Compile(); err == nil {
		graph := linter.New().GetCallGraphFromSource(cob, source)
		if graph != nil && len(graph.Nodes) > 0 {
			out["callGraphNodes"] = graph.Nodes
			out["callGraphEdges"] = graph.Edges
			return
		}
	}

	nodes, edges := extractCallGraphFromSource(source)
	if len(nodes) > 0 {
		out["callGraphNodes"] = nodes
		out["callGraphEdges"] = edges
	}
}

func describeCRT(_ *Renderer, _ string, data []byte, out map[string]any) {
	file, err := crt.Load(data)
	if err != nil {
		return
	}
	out["format"] = "CRT Scenario"
	out["unitCount"] = len(file.Units)
	out["triggerCount"] = len(file.Triggers)

	type unit struct {
		Type   string `json:"type"`
		Name   string `json:"name,omitempty"`
		Player int    `json:"player"`
		X      int    `json:"x"`
		Y      int    `json:"y"`
		Z      int    `json:"z"`
	}
	units := make([]unit, 0, len(file.Units))
	for _, u := range file.Units {
		units = append(units, unit{
			Type: u.Type, Name: u.Name, Player: int(u.Player),
			X: int(u.X), Y: int(u.Y), Z: int(u.Z),
		})
	}
	out["units"] = units

	type trigger struct {
		Name                     string `json:"name"`
		Left, Top, Right, Bottom int
	}
	triggers := make([]trigger, 0, len(file.Triggers))
	for _, t := range file.Triggers {
		triggers = append(triggers, trigger{
			Name: t.Name, Left: int(t.Left), Top: int(t.Top),
			Right: int(t.Right), Bottom: int(t.Bottom),
		})
	}
	out["triggers"] = triggers

	type player struct {
		Slot  int `json:"slot"`
		Rules int `json:"rules"`
	}
	players := make([]player, 0, len(file.Players))
	for i, p := range file.Players {
		if len(p.Rules) == 0 {
			continue
		}
		players = append(players, player{Slot: i, Rules: len(p.Rules)})
	}
	out["players"] = players
}

func describe3DO(_ *Renderer, _ string, data []byte, out map[string]any) {
	model, err := objects3d.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	out["format"] = "3DO Model"
	out["totalObjects"] = len(model.AllObjects)
	out["totalVertices"] = model.TotalVertices()
	out["totalPrimitives"] = model.TotalPrimitives()
	out["textures"] = model.Textures()

	type object struct {
		Name       string `json:"name"`
		Vertices   int    `json:"vertices"`
		Primitives int    `json:"primitives"`
		Children   int    `json:"children"`
		Depth      int    `json:"depth"`
	}
	var objects []object
	var walk func(o *objects3d.Object, depth int)
	walk = func(o *objects3d.Object, depth int) {
		objects = append(objects, object{
			Name: o.Name, Vertices: len(o.Vertices),
			Primitives: len(o.Primitives), Children: len(o.Children), Depth: depth,
		})
		for _, c := range o.Children {
			walk(c, depth+1)
		}
	}
	walk(model.Root, 0)
	out["objects"] = objects
}

func describeHPI(_ *Renderer, vpath string, data []byte, out map[string]any) {
	// The HPI reader works off a file path, so spill the VFS bytes to a temp
	// file for the duration of the read.
	tmp, err := os.CreateTemp("", "hpi-*"+path.Ext(vpath))
	if err != nil {
		return
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return
	}
	_ = tmp.Close()

	archive, err := hpi.OpenReader(tmp.Name())
	if err != nil {
		return
	}
	defer func() { _ = archive.Close() }()

	out["format"] = "HPI Archive"
	out["hpiVersion"] = archive.Version()

	files := archive.List()
	out["fileCount"] = len(files)

	var total uint64
	_ = archive.Walk(func(e *hpi.Entry) error {
		if !e.IsDir {
			total += uint64(e.Size)
		}
		return nil
	})
	out["unpackedSize"] = total
	out["files"] = files
}

func describeFNT(_ *Renderer, _ string, data []byte, out map[string]any) {
	font, err := fnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	out["format"] = "TA Font"
	out["height"] = font.Height
	out["glyphCount"] = font.GlyphCount()
	out["flags"] = font.Flags

	type glyph struct {
		Char  int `json:"char"`
		Width int `json:"width"`
	}
	var glyphs []glyph
	for ch := 0; ch < 256; ch++ {
		if g := font.Glyphs[ch]; g != nil {
			glyphs = append(glyphs, glyph{Char: ch, Width: g.Width})
		}
	}
	out["glyphs"] = glyphs
}

func describePAL(_ *Renderer, _ string, data []byte, out map[string]any) {
	out["format"] = "Palette"
	if len(data) < 4 {
		return
	}
	count := len(data) / 4
	if count > 256 {
		count = 256
	}
	type entry struct {
		Index      int    `json:"index"`
		R, G, B, A int    `json:"-"`
		Hex        string `json:"hex"`
	}
	colors := make([]entry, 0, count)
	for i := 0; i < count; i++ {
		off := i * 4
		colors = append(colors, entry{
			Index: i,
			R:     int(data[off]), G: int(data[off+1]), B: int(data[off+2]), A: int(data[off+3]),
			Hex: fmt.Sprintf("#%02X%02X%02X", data[off], data[off+1], data[off+2]),
		})
	}
	out["colors"] = colors
	out["colorCount"] = count
}

func describeSCT(_ *Renderer, _ string, data []byte, out map[string]any) {
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	out["format"] = "SCT Section"
	out["width"] = section.Header.Width
	out["height"] = section.Header.Height
	out["numTiles"] = section.Header.NumTiles
	out["pixelWidth"] = section.Header.Width * 32
	out["pixelHeight"] = section.Header.Height * 32
	out["hasMinimap"] = section.Minimap != nil
	out["hasHeightMap"] = section.HeightMap != nil
}

func describeTNT(r *Renderer, vpath string, data []byte, out map[string]any) {
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	out["format"] = "TNT Map"
	out["width"] = m.Header.Width
	out["height"] = m.Header.Height
	out["tileW"] = m.TileW
	out["tileH"] = m.TileH
	out["pixelW"] = m.TileW * 32
	out["pixelH"] = m.TileH * 32
	out["numTiles"] = len(m.Tiles)
	out["tileAnims"] = m.Header.TileAnims
	out["seaLevel"] = m.Header.SeaLevel
	out["hasMinimap"] = m.Minimap != nil
	out["minimapW"] = m.MinimapW
	out["minimapH"] = m.MinimapH

	features, _ := m.LoadFeatures(bytes.NewReader(data))
	placements := m.GetFeaturePlacements()

	counts := map[int]int{}
	for _, p := range placements {
		counts[p.FeatureIdx]++
	}

	type feature struct {
		Index       int    `json:"index"`
		Name        string `json:"name"`
		Description string `json:"description,omitempty"`
		Category    string `json:"category,omitempty"`
		Filename    string `json:"filename,omitempty"`
		Seqname     string `json:"seqname,omitempty"`
		Count       int    `json:"count"`
	}
	fis := make([]feature, len(features))
	for i, f := range features {
		fi := feature{Index: f.Index, Name: f.Name, Count: counts[i]}
		fi.Description, fi.Category, fi.Filename, fi.Seqname = r.lookupFeatureTDF(f.Name)
		fis[i] = fi
	}
	out["features"] = fis

	type placement struct {
		FeatureIdx int `json:"featureIdx"`
		PixelX     int `json:"pixelX"`
		PixelY     int `json:"pixelY"`
	}
	pis := make([]placement, len(placements))
	for i, p := range placements {
		pis[i] = placement{FeatureIdx: p.FeatureIdx, PixelX: p.PixelX, PixelY: p.PixelY}
	}
	out["placements"] = pis

	mmW, mmH := m.MinimapContentBounds()
	if positions := r.tntStartPositions(vpath, m, mmW, mmH); len(positions) > 0 {
		out["startPositions"] = positions
	}
}

// lookupFeatureTDF scans features/*.tdf for the named feature and returns its
// presentation metadata. Empty strings mean the feature wasn't found.
func (r *Renderer) lookupFeatureTDF(name string) (description, category, filename, seqname string) {
	if r.vfs == nil {
		return
	}
	upper := strings.ToUpper(name)
	for _, fp := range r.vfs.List() {
		if !strings.HasPrefix(fp, "features/") || !strings.HasSuffix(strings.ToLower(fp), ".tdf") {
			continue
		}
		data, err := r.vfs.ReadFile(fp)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			if strings.ToUpper(sec.Name()) == upper {
				return sec.String("description"), sec.String("category"),
					sec.String("filename"), sec.String("seqname")
			}
		}
	}
	return
}

type startPosition struct {
	Number int     `json:"number"`
	X      int     `json:"x"`
	Y      int     `json:"y"`
	PctX   float64 `json:"pctX"`
	PctY   float64 `json:"pctY"`
}

// tntStartPositions reads the map's companion .ota and projects each StartPos
// into minimap percentages so the UI can overlay them.
func (r *Renderer) tntStartPositions(vpath string, m *tnt.Map, mmContentW, mmContentH int) []startPosition {
	if r.vfs == nil {
		return nil
	}
	otaPath := strings.TrimSuffix(vpath, path.Ext(vpath)) + ".ota"
	otaData, err := r.vfs.ReadFile(otaPath)
	if err != nil {
		return nil
	}
	doc, err := tdf.ParseString(string(otaData))
	if err != nil {
		return nil
	}
	specials := findSection(doc.Section("GlobalHeader"), "Schema 0", "specials")
	if specials == nil {
		return nil
	}

	pixelW, pixelH := m.TileW*32, m.TileH*32
	var positions []startPosition
	for _, special := range specials.Sections() {
		what := special.String("specialwhat")
		if !strings.HasPrefix(what, "StartPos") {
			continue
		}
		num := 0
		_, _ = fmt.Sscanf(strings.TrimPrefix(what, "StartPos"), "%d", &num)
		x, y := special.Int("XPos"), special.Int("ZPos")
		if pixelW <= 0 || pixelH <= 0 || m.MinimapW <= 0 || m.MinimapH <= 0 {
			continue
		}
		mmX := (float64(x) / float64(pixelW)) * float64(mmContentW)
		mmY := (float64(y) / float64(pixelH)) * float64(mmContentH)
		positions = append(positions, startPosition{
			Number: num, X: x, Y: y,
			PctX: mmX / float64(m.MinimapW) * 100,
			PctY: mmY / float64(m.MinimapH) * 100,
		})
	}
	return positions
}

// findSection walks a chain of nested section names from root, returning the
// final section or nil if any link is missing.
func findSection(root *tdf.Section, names ...string) *tdf.Section {
	cur := root
	for _, name := range names {
		if cur == nil {
			return nil
		}
		var next *tdf.Section
		for _, s := range cur.Sections() {
			if s.Name() == name {
				next = s
				break
			}
		}
		cur = next
	}
	return cur
}

// extractCallGraphFromSource is the best-effort text fallback used when a BOS
// file won't compile on its own. It recognises function declarations and the
// call-script / start-script / signal / set-signal-mask directives, returning
// deduplicated nodes and edges in the same shape the compiled path produces.
func extractCallGraphFromSource(source string) ([]linter.CallGraphNode, []linter.CallGraphEdge) {
	lines := strings.Split(source, "\n")
	nodeType := make(map[string]string)
	var edges []linter.CallGraphEdge
	current := ""

	addEdge := func(to, typ string) {
		nodeType[to] = "function"
		if typ == "signal" || typ == "set-mask" {
			nodeType[to] = "signal"
		}
		edges = append(edges, linter.CallGraphEdge{From: current, To: to, Type: typ})
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if idx := strings.Index(trimmed, "("); idx > 0 &&
			!strings.HasPrefix(trimmed, "if ") && !strings.HasPrefix(trimmed, "while ") &&
			!strings.HasPrefix(trimmed, "start-script ") && !strings.HasPrefix(trimmed, "call-script ") &&
			!strings.HasPrefix(trimmed, "//") {
			fnName := trimmed[:idx]
			if len(fnName) > 0 && fnName[0] != '#' && isIdentifier(fnName) {
				current = fnName
				nodeType[fnName] = "function"
			}
		}
		if current == "" {
			continue
		}

		switch {
		case strings.HasPrefix(trimmed, "call-script "):
			if rest := strings.TrimPrefix(trimmed, "call-script "); true {
				if idx := strings.Index(rest, "("); idx > 0 {
					addEdge(rest[:idx], "call")
				}
			}
		case strings.HasPrefix(trimmed, "start-script "):
			if rest := strings.TrimPrefix(trimmed, "start-script "); true {
				if idx := strings.Index(rest, "("); idx > 0 {
					addEdge(rest[:idx], "start")
				}
			}
		case strings.HasPrefix(trimmed, "signal "):
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "signal "), ";")
			addEdge("SIG:"+strings.TrimSpace(val), "signal")
		case strings.HasPrefix(trimmed, "set-signal-mask "):
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "set-signal-mask "), ";")
			addEdge("SIG:"+strings.TrimSpace(val), "set-mask")
		}
	}

	type edgeKey struct{ from, to, typ string }
	seen := make(map[edgeKey]bool)
	uniqueEdges := make([]linter.CallGraphEdge, 0, len(edges))
	for _, e := range edges {
		k := edgeKey{e.From, e.To, e.Type}
		if !seen[k] {
			seen[k] = true
			uniqueEdges = append(uniqueEdges, e)
		}
	}

	nodes := make([]linter.CallGraphNode, 0, len(nodeType))
	for name, typ := range nodeType {
		nodes = append(nodes, linter.CallGraphNode{Name: name, Type: typ})
	}
	return nodes, uniqueEdges
}

// isIdentifier reports whether s is a bare BOS identifier (letters, digits,
// underscores), used to filter out punctuation when scanning for declarations.
func isIdentifier(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, ch := range s {
		if (ch < 'a' || ch > 'z') && (ch < 'A' || ch > 'Z') && (ch < '0' || ch > '9') && ch != '_' {
			return false
		}
	}
	return true
}

// isProbablyText reports whether data looks like UTF-8/ASCII text rather than
// binary, by sampling the head for NUL bytes.
func isProbablyText(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	sample := data
	if len(sample) > 512 {
		sample = sample[:512]
	}
	return !bytes.ContainsRune(sample, 0)
}
