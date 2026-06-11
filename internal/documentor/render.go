// Package documentor extracts reference data from a flattened Total
// Annihilation install and renders the markdown catalogues consumed by
// the standalone github.com/coreprime/reference-ta repo.
package documentor

import (
	"bytes"
	"embed"
	"fmt"
	"html"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"
)

//go:embed templates/*.tmpl
var templateFS embed.FS

// Options controls a single documentation run.
type Options struct {
	// Game selects which title to document. Default: GameTotalA.
	Game Game

	// Source is the path to the flattened install (the same shape
	// "kbot mount --flatten" produces).
	Source string

	// Target is the root of the reference repo to write into.
	// <prefix>-*.md files land at Target/; portraits at
	// Target/img/<prefix>-units/. Prefix is "ta" or "tak" per game.
	Target string

	// SkipPortraits disables the unitpics/*.pcx → PNG batch step.
	SkipPortraits bool

	// PortraitsSkipExisting avoids re-converting portraits that already
	// exist at the destination. Default true; pass false to force a
	// fresh batch.
	PortraitsSkipExisting bool

	// Logger writes one-line progress messages.  Pass nil to silence.
	Logger func(format string, args ...any)
}

func (o Options) logf(format string, args ...any) {
	if o.Logger != nil {
		o.Logger(format, args...)
	}
}

// Generate is the package-level entrypoint that drives one full
// extract → render → portrait-batch cycle.
func Generate(opts Options) error {
	if opts.Source == "" {
		return fmt.Errorf("documentor: Source is required")
	}
	if opts.Target == "" {
		return fmt.Errorf("documentor: Target is required")
	}
	if opts.Game == "" {
		opts.Game = GameTotalA
	}
	if err := os.MkdirAll(opts.Target, 0o755); err != nil {
		return fmt.Errorf("create target: %w", err)
	}

	opts.logf("Extracting %s data from %s ...", opts.Game.HumanName(), opts.Source)
	ds, err := Extract(opts.Source, opts.Game)
	if err != nil {
		return err
	}
	opts.logf("  %d units, %d weapons, %d builders",
		len(ds.Units), len(ds.Weapons), len(ds.Build.Slots))

	// Run the portrait batch first so the renderer can omit <img> tags
	// for units whose portraits don't exist (TA:K has ~30 monster/NPC/
	// wildlife units with no buildpic JPG).
	portraitsDir := filepath.Join(opts.Target, opts.Game.PortraitDir())
	if !opts.SkipPortraits {
		opts.logf("Converting unit portraits ...")
		res, err := ConvertPortraitsForGame(opts.Source, portraitsDir, opts.PortraitsSkipExisting, opts.Game)
		if err != nil {
			return fmt.Errorf("portraits: %w", err)
		}
		opts.logf("  %d converted, %d skipped, %d failed", res.Converted, res.Skipped, res.Failed)
	}

	// Scan the (possibly just-populated) portrait directory so the
	// template helpers know which units have art and which need an
	// em-dash placeholder.
	available := scanPortraitBasenames(portraitsDir, opts.Game.PortraitExt())
	tpls, err := loadTemplatesFor(opts.Game.Prefix(), opts.Game.PortraitExt(), available)
	if err != nil {
		return fmt.Errorf("load templates: %w", err)
	}

	type render struct {
		name string
		view any
		tmpl string
	}
	prefix := opts.Game.Prefix()
	renders := []render{
		{name: prefix + "-units.md", view: BuildUnitsView(ds), tmpl: prefix + "-units.md.tmpl"},
		{name: prefix + "-weapons.md", view: BuildWeaponsView(ds), tmpl: prefix + "-weapons.md.tmpl"},
		{name: prefix + "-buildtree.md", view: BuildBuildTreeView(ds), tmpl: prefix + "-buildtree.md.tmpl"},
	}
	for _, r := range renders {
		path := filepath.Join(opts.Target, r.name)
		if err := executeTemplate(tpls, r.tmpl, r.view, path); err != nil {
			return fmt.Errorf("render %s: %w", r.name, err)
		}
		opts.logf("  wrote %s", path)
	}
	return nil
}

// scanPortraitBasenames returns the set of <basename> values present
// in dir as files of the given extension.  Used by the template
// helpers to know which units have rendered portraits.  An empty set
// is returned (without error) when the directory doesn't exist yet.
func scanPortraitBasenames(dir, ext string) map[string]bool {
	out := map[string]bool{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.EqualFold(filepath.Ext(name), ext) {
			continue
		}
		out[strings.ToLower(strings.TrimSuffix(name, filepath.Ext(name)))] = true
	}
	return out
}

// loadTemplatesFor returns a parsed template set whose helpers emit
// the per-game image-path prefix (e.g. "ta" → "img/ta-units/…"),
// file extension (".png" for TA, ".jpg" for TA:K), and a set of
// portrait basenames that actually exist on disk (so missing units
// render as em-dashes rather than broken-image references).
func loadTemplatesFor(prefix, ext string, available map[string]bool) (*template.Template, error) {
	root := template.New("").Funcs(funcMapFor(prefix, ext, available))
	files, err := fs.Glob(templateFS, "templates/*.tmpl")
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		data, err := templateFS.ReadFile(f)
		if err != nil {
			return nil, err
		}
		name := filepath.Base(f)
		if _, err := root.New(name).Parse(string(data)); err != nil {
			return nil, fmt.Errorf("parse %s: %w", name, err)
		}
	}
	return root, nil
}

func executeTemplate(root *template.Template, name string, data any, outPath string) error {
	var buf bytes.Buffer
	if err := root.ExecuteTemplate(&buf, name, data); err != nil {
		return err
	}
	return os.WriteFile(outPath, buf.Bytes(), 0o644)
}

// ----- template helpers -----

// funcMapFor returns the helper-funcs bound to a per-game portrait
// directory prefix, file extension, and known-portrait set. Templates
// call `pic` etc. without knowing which game they're rendering for.
func funcMapFor(prefix, ext string, available map[string]bool) template.FuncMap {
	pic := tplPicFor(prefix, ext, available)
	return template.FuncMap{
		"pic":        pic,
		"unitLabel":  tplUnitLabel,
		"weaponCell": tplWeaponList,
		"trim":       strings.TrimSpace,
		"truncate":   tplTruncate,
		"escapePipe": func(s string) string { return strings.ReplaceAll(s, "|", `\|`) },
		"defaultDash": func(s string) string {
			if s == "" {
				return "—"
			}
			return s
		},
		"join":       strings.Join,
		"upper":      strings.ToUpper,
		"lower":      strings.ToLower,
		"toAnchor":   tplAnchor,
		"plural":     tplPlural,
		"htmlEscape": html.EscapeString,
		"slotCell":   tplSlotCellFor(pic),
		"badge": func(s BuildSlot) string {
			if s.IsDownload() {
				return " ⬇️"
			}
			return ""
		},
		"chunk":      tplChunk,
		"usedByCell": tplUsedByCell,
		"joinCodes":  tplJoinCodes,
		"slotAt": func(p BuildPage, btn int) *BuildSlot {
			if s, ok := p.Slots[btn]; ok {
				return &s
			}
			return nil
		},
		"dict":        tplDict,
		"chunkUnits":  tplChunkUnits,
		"padCells":    tplPadCells,
		"sortedSlots": tplSortedSlots,
	}
}

// tplPicFor returns a per-game portrait renderer.  Bound to the
// prefix ("ta"/"tak"), the file extension (".png"/".jpg"), and the
// set of portrait basenames present on disk at render time. Units
// missing from `available` render as an em-dash placeholder so the
// rendered table doesn't ship broken-image references.
func tplPicFor(prefix, ext string, available map[string]bool) func(Unit, int) string {
	return func(u Unit, width int) string {
		obj := strings.ToLower(strings.TrimSpace(u.Objectname))
		if obj == "" {
			obj = strings.ToLower(u.UnitName)
		}
		if obj == "" {
			return "—"
		}
		if available != nil && !available[obj] {
			return "—"
		}
		alt := u.Name
		if alt == "" {
			alt = u.UnitName
		}
		alt = html.EscapeString(alt)
		return fmt.Sprintf(`<img src="img/%s-units/%s%s" width="%d" alt="%s" title="%s" />`,
			prefix, obj, ext, width, alt, html.EscapeString(u.UnitName))
	}
}

func tplUnitLabel(u Unit) string {
	if u.UnitName == "" {
		return "<em>(undefined)</em>"
	}
	if u.Name != "" {
		return html.EscapeString(u.Name)
	}
	if u.Designation != "" {
		return html.EscapeString(u.Designation)
	}
	return html.EscapeString(u.UnitName)
}

func tplWeaponList(u Unit) string {
	ws := u.Weapons()
	if len(ws) == 0 {
		return "—"
	}
	joined := strings.Join(ws, ", ")
	return tplTruncate(joined, 50)
}

func tplTruncate(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// tplAnchor approximates GitHub's heading-to-slug algorithm:
//  1. Lowercase.
//  2. Convert em-dash (—) to a regular hyphen — GitHub does this.
//  3. Drop everything that isn't alphanumeric, space, or hyphen.
//  4. Replace spaces with hyphens, **preserving runs** (GitHub does NOT
//     collapse `--` into `-`, so `ARM — Commander` becomes
//     `arm---commander`, not `arm-commander`).
var anchorDropRe = regexp.MustCompile(`[^a-z0-9 \-]+`)

func tplAnchor(s string) string {
	a := strings.ToLower(s)
	a = strings.ReplaceAll(a, "—", "-")
	a = anchorDropRe.ReplaceAllString(a, "")
	a = strings.ReplaceAll(a, " ", "-")
	return strings.Trim(a, "-")
}

func tplPlural(n int, singular, plural string) string {
	if n == 1 {
		return singular
	}
	return plural
}

// tplSlotCellFor returns a slot-cell renderer bound to a portrait pic
// helper. The slot's unit is looked up in `units`.
func tplSlotCellFor(pic func(Unit, int) string) func(*BuildSlot, map[string]Unit) string {
	return func(slot *BuildSlot, units map[string]Unit) string {
		if slot == nil {
			return `<td valign="top" align="center" style="color:#aaa">·</td>`
		}
		u := units[slot.Unit]
		if u.UnitName == "" {
			u = Unit{UnitName: slot.Unit}
		}
		img := pic(u, 48)
		if img == "—" {
			img = `<span style="font-size:10px">(no pic)</span>`
		}
		badge := ""
		if slot.IsDownload() {
			badge = " ⬇️"
		}
		return fmt.Sprintf(`<td valign="top" align="center">%s<br/><code>%s</code>%s<br/><sub>%s</sub></td>`,
			img, slot.Unit, badge, tplUnitLabel(u))
	}
}

// tplUsedByCell renders the "Used by" column in the weapon table.
func tplUsedByCell(m WeaponUserMap, key string) string {
	users := m[key]
	if len(users) == 0 {
		return "— *(unused / engine-fired)*"
	}
	const maxInline = 6
	var bits []string
	for i, u := range users {
		if i >= maxInline {
			bits = append(bits, fmt.Sprintf("… (+%d more)", len(users)-maxInline))
			break
		}
		bits = append(bits, "`"+u+"`")
	}
	return strings.Join(bits, ", ")
}

// tplJoinCodes wraps each string in `backticks` and joins with ", ".
func tplJoinCodes(items []string) string {
	if len(items) == 0 {
		return "—"
	}
	bits := make([]string, len(items))
	for i, s := range items {
		bits[i] = "`" + s + "`"
	}
	return strings.Join(bits, ", ")
}

// tplSortedSlots returns every slot in a BuilderView in deterministic
// (page, button) order. Useful when a template needs to iterate slots
// as a flat list — TA:K's build menu, for instance, is one linear list
// per builder rather than the 2×3 paged grid TA uses.
func tplSortedSlots(b BuilderView) []BuildSlot {
	var out []BuildSlot
	for _, p := range b.Pages {
		buttons := make([]int, 0, len(p.Slots))
		for btn := range p.Slots {
			buttons = append(buttons, btn)
		}
		sortInts(buttons)
		for _, btn := range buttons {
			out = append(out, p.Slots[btn])
		}
	}
	return out
}

func sortInts(s []int) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

// tplDict is the standard go-template "dict" helper: takes alternating
// key/value pairs and returns a map. Used so sub-templates can receive a
// single struct-like value.
func tplDict(kv ...any) (map[string]any, error) {
	if len(kv)%2 != 0 {
		return nil, fmt.Errorf("dict requires an even number of arguments")
	}
	m := make(map[string]any, len(kv)/2)
	for i := 0; i < len(kv); i += 2 {
		k, ok := kv[i].(string)
		if !ok {
			return nil, fmt.Errorf("dict key at position %d is not a string", i)
		}
		m[k] = kv[i+1]
	}
	return m, nil
}

// tplChunkUnits splits a []Unit into fixed-size sub-slices.
func tplChunkUnits(size int, items []Unit) [][]Unit {
	if size <= 0 {
		return nil
	}
	out := make([][]Unit, 0, (len(items)+size-1)/size)
	for i := 0; i < len(items); i += size {
		end := i + size
		if end > len(items) {
			end = len(items)
		}
		out = append(out, items[i:end])
	}
	return out
}

// tplPadCells emits `<td>&nbsp;</td>` repeated (total-filled) times.
func tplPadCells(total, filled int) string {
	if filled >= total {
		return ""
	}
	return strings.Repeat(`<td>&nbsp;</td>`, total-filled)
}

// tplChunk splits a slice of any type into fixed-size chunks (last may be short).
func tplChunk(size int, items any) [][]any {
	// reflect-light: accept []string only — that's all the templates use.
	switch s := items.(type) {
	case []string:
		out := [][]any{}
		for i := 0; i < len(s); i += size {
			end := i + size
			if end > len(s) {
				end = len(s)
			}
			chunk := make([]any, 0, end-i)
			for _, x := range s[i:end] {
				chunk = append(chunk, x)
			}
			out = append(out, chunk)
		}
		return out
	}
	return nil
}
