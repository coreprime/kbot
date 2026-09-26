// Package aiprofile turns a computer-player profile (ai/*.txt) into the view
// the studio's AI viewer and `kbot mount` show, following how TA 3.1c reads
// it (see kbot-io's formats/ai):
//
//   - lines before the first plan line are ignored when a game starts;
//   - a target is a unit name, a category word matched against each unit's
//     FBI Category, or ALL, and a unit line locks that unit; a category no
//     unit has (often a misspelt unit name) does nothing and is flagged;
//   - a limit of -1 is unlimited, 0 and any other negative value forbid;
//   - values are numeric prefixes ("O" reads as 0), which the parser's
//     diagnostics explain.
//
// Telling a unit from a category needs the install's unit table; Units reads
// it from a mounted VFS.
package aiprofile

import (
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/ai"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// Target kinds as the views label them.
const (
	KindUnit     = "unit"
	KindCategory = "category"
	KindAll      = "all"
	// KindNone marks a directive with no target word, which applies to
	// nothing.
	KindNone = "none"
)

// Weight is one weight directive.
type Weight struct {
	// Target is the target word upper-cased; empty when the line has none.
	Target string `json:"unit"`
	// Kind is KindUnit, KindCategory, KindAll or KindNone; empty when no
	// unit table was available to tell units from categories.
	Kind string `json:"kind,omitempty"`
	// MatchesNone is set when Kind is KindCategory and no unit in the table
	// has that category: the line does nothing (often a misspelt unit
	// name).
	MatchesNone bool `json:"matchesNone,omitempty"`
	// Weight is the multiplier the game reads.
	Weight float64 `json:"weight"`
	// Raw is the value word as written.
	Raw  string `json:"raw"`
	Line int    `json:"line"`
}

// Limit is one limit directive.
type Limit struct {
	Target string `json:"unit"`
	Kind   string `json:"kind,omitempty"`
	// MatchesNone is as for Weight.
	MatchesNone bool `json:"matchesNone,omitempty"`
	// Maximum is the value the game reads: -1 unlimited, 0 or any other
	// negative value forbids, N caps the count.
	Maximum   int    `json:"maximum"`
	Unlimited bool   `json:"unlimited"`
	Forbids   bool   `json:"forbids"`
	Raw       string `json:"raw"`
	Line      int    `json:"line"`
}

// Plan is one plan line and the directives under it, or the lines before the
// first plan line.
type Plan struct {
	Name    string   `json:"name"`
	Line    int      `json:"line"`
	Weights []Weight `json:"weights"`
	Limits  []Limit  `json:"limits"`
}

// Setting is the state a unit is left in at one difficulty.
type Setting struct {
	Unit          string `json:"unit"`
	WeightPercent int    `json:"weightPercent"`
	WeightLocked  bool   `json:"weightLocked"`
	Limit         int    `json:"limit"`
	LimitLocked   bool   `json:"limitLocked"`
	Forbidden     bool   `json:"forbidden"`
}

// Effective lists, for one difficulty, the units whose settings differ from
// the defaults (100% weight, unlimited) when a game starts.
type Effective struct {
	Difficulty string    `json:"difficulty"`
	Units      []Setting `json:"units"`
}

// Diagnostic explains how the game reads a line that is not written the usual
// way.
type Diagnostic struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}

// Profile is the whole view of one profile.
type Profile struct {
	// Preamble holds the directives before the first plan line, which TA
	// ignores when a game starts; nil when there are none.
	Preamble    *Plan        `json:"preamble,omitempty"`
	Plans       []Plan       `json:"plans"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	// UnitsKnown reports whether a unit table was available, so Kind is set
	// and Effective computed.
	UnitsKnown bool `json:"unitsKnown"`
	// Effective holds the settings per difficulty when the profile has plan
	// lines and a unit table was available.
	Effective []Effective `json:"effective,omitempty"`
}

// Units reads the install's unit table from units/*.fbi: each unit's name and
// FBI Category words. Files that do not decode, or have no UnitName, are
// skipped.
func Units(vfs *filesystem.VirtualFileSystem) []ai.Unit {
	if vfs == nil {
		return nil
	}
	names, err := vfs.ListDir("units")
	if err != nil {
		return nil
	}
	sort.Strings(names)
	var out []ai.Unit
	seen := map[string]bool{}
	for _, name := range names {
		if !strings.EqualFold(path.Ext(name), ".fbi") {
			continue
		}
		data, err := vfs.ReadFile(path.Join("units", name))
		if err != nil {
			continue
		}
		var u ta.Unit
		if tdf.Unmarshal(data, &u) != nil || u.Info.UnitName == "" {
			continue
		}
		key := strings.ToUpper(u.Info.UnitName)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, ai.Unit{Name: u.Info.UnitName, Categories: u.Info.Category})
	}
	return out
}

// Build parses a profile and resolves its targets against units (nil when no
// unit table is available).
func Build(data []byte, units []ai.Unit) *Profile {
	f, _ := ai.Parse(data) // never fails; oddities are in f.Diagnostics
	p := &Profile{Plans: []Plan{}, Diagnostics: []Diagnostic{}, UnitsKnown: len(units) > 0}
	var res *ai.Resolver
	if p.UnitsKnown {
		res = ai.NewResolver(units)
	}
	if f.Preamble != nil {
		pre := convertPlan(f.Preamble, res)
		p.Preamble = &pre
	}
	for i := range f.Plans {
		p.Plans = append(p.Plans, convertPlan(&f.Plans[i], res))
	}
	for _, d := range f.Diagnostics {
		p.Diagnostics = append(p.Diagnostics, Diagnostic{Line: d.Line, Message: d.Message})
	}
	if res != nil && len(f.Plans) > 0 {
		for _, d := range []ai.Difficulty{ai.Easy, ai.Medium, ai.Hard} {
			p.Effective = append(p.Effective, effective(res.Apply(f, d), d))
		}
	}
	return p
}

func convertPlan(src *ai.DifficultyPlan, res *ai.Resolver) Plan {
	pl := Plan{Name: src.Name, Line: src.Line, Weights: []Weight{}, Limits: []Limit{}}
	for _, w := range src.Weights {
		k := kind(res, w.UnitName)
		pl.Weights = append(pl.Weights, Weight{
			Target: w.UnitName, Kind: k, MatchesNone: matchesNone(res, k, w.UnitName),
			Weight: w.Weight, Raw: w.RawValue, Line: w.Line,
		})
	}
	for _, l := range src.Limits {
		k := kind(res, l.UnitName)
		pl.Limits = append(pl.Limits, Limit{
			Target: l.UnitName, Kind: k, MatchesNone: matchesNone(res, k, l.UnitName), Maximum: l.Maximum,
			Unlimited: l.Unlimited(), Forbids: l.Forbids(), Raw: l.RawValue, Line: l.Line,
		})
	}
	return pl
}

// kind labels a target; empty when there is no unit table to tell units from
// categories.
func kind(res *ai.Resolver, target string) string {
	if target == "" {
		return KindNone
	}
	if res == nil {
		return ""
	}
	switch res.Kind(target) {
	case ai.TargetUnit:
		return KindUnit
	case ai.TargetAll:
		return KindAll
	default:
		return KindCategory
	}
}

// matchesNone reports whether a category target applies to no unit in the
// table.
func matchesNone(res *ai.Resolver, kind, target string) bool {
	return res != nil && kind == KindCategory && len(res.Matches(target)) == 0
}

func effective(settings map[string]ai.Setting, d ai.Difficulty) Effective {
	e := Effective{Difficulty: d.String(), Units: []Setting{}}
	for name, s := range settings {
		if s.WeightPercent == 100 && s.Limit == -1 && !s.WeightLocked && !s.LimitLocked {
			continue
		}
		e.Units = append(e.Units, Setting{
			Unit: name, WeightPercent: s.WeightPercent, WeightLocked: s.WeightLocked,
			Limit: s.Limit, LimitLocked: s.LimitLocked, Forbidden: s.Forbidden(),
		})
	}
	sort.Slice(e.Units, func(i, j int) bool { return e.Units[i].Unit < e.Units[j].Unit })
	return e
}

// WrittenNote explains a value word the game reads differently from how it
// looks, given the value the game reads: "written \"O\"" when the word is
// not a number or is a different number (the game reads only its numeric
// prefix), "no value: reads as 0" when the line has no value word, and ""
// when the word is that number however it is written (".1", "0.10", "+4").
func WrittenNote(raw string, read float64) string {
	if raw == "" {
		return "no value: reads as 0"
	}
	if v, err := strconv.ParseFloat(raw, 64); err == nil && v == read {
		return ""
	}
	return "written " + strconv.Quote(raw)
}

// LimitLabel renders a limit the way the game treats it: "unlimited" for -1,
// "disabled" for 0 or any other negative value, else "max N".
func LimitLabel(maximum int) string {
	switch {
	case maximum == -1:
		return "unlimited"
	case maximum <= 0:
		return "disabled"
	default:
		return "max " + strconv.Itoa(maximum)
	}
}
