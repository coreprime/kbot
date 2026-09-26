package assetrender

import (
	"bytes"
	"fmt"
	"path"
	"strings"

	"github.com/coreprime/kbot-io/formats/ai"
	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/pcx"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// describer turns a file's bytes into a structured, JSON-serialisable map of
// format-specific facts. It receives the owning Renderer so describers that
// need sidecar files (a TNT's companion .ota, a BOS's #include tree) can read
// them through the VFS rather than reaching for a package global.
type describer func(r *Renderer, vpath string, data []byte, out map[string]any)

// describers maps a lowercased file extension to the describer that handles it.
// The simple, self-contained formats live here; the heavier structured and
// script-analysis describers are registered from describe_more.go.
var describers = map[string]describer{
	".tdf": describeTDF,
	".fbi": describeTDF,
	".gui": describeTDF,
	".ota": describeTDF,
	".gaf": describeGAF,
	".pcx": describePCX,
}

// Describe returns a structured description of the file at vpath given its
// bytes. The bool reports whether a format-specific describer recognised the
// extension; when false the returned map carries only the seeded "format" key
// and the caller should fall back to generic metadata.
func (r *Renderer) Describe(vpath string, data []byte) (map[string]any, bool) {
	out := map[string]any{"format": ""}
	ext := strings.ToLower(path.Ext(vpath))
	d, ok := describers[ext]
	if !ok {
		// A .txt that parses as an AI profile is described as one; this mirrors
		// how TA ships some bot profiles with a plain .txt extension.
		if ext == ".txt" && ai.IsAIFile(data) {
			describeAI(r, vpath, data, out)
			return out, true
		}
		return out, false
	}
	d(r, vpath, data, out)
	return out, true
}

// describeTDF shows a TDF, FBI, GUI or OTA as the game reads it: kbot-io's
// Document uses the game's grammar (comments blanked, a value runs to the
// next ';', one-line `[NAME] {}` sections), and its diagnostics note text the
// game reads differently from how it looks.
func describeTDF(_ *Renderer, vpath string, data []byte, out map[string]any) {
	doc, err := tdf.ParseString(string(data))
	if err != nil {
		return
	}
	ext := strings.ToLower(path.Ext(vpath))
	if len(ext) > 1 {
		out["format"] = strings.ToUpper(ext[1:])
	}

	type field struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	type section struct {
		Name     string    `json:"name"`
		Fields   []field   `json:"fields"`
		Children []section `json:"children,omitempty"`
	}

	var convert func(s *tdf.Section) section
	convert = func(s *tdf.Section) section {
		sec := section{Name: s.Name()}
		for _, f := range s.Fields() {
			sec.Fields = append(sec.Fields, field{Key: f.Key(), Value: f.Value()})
		}
		for _, child := range s.Sections() {
			sec.Children = append(sec.Children, convert(child))
		}
		return sec
	}

	var sections []section
	for _, s := range doc.Sections() {
		sections = append(sections, convert(s))
	}
	out["sections"] = sections
	diags := make([]string, 0, len(doc.Diagnostics()))
	for _, d := range doc.Diagnostics() {
		diags = append(diags, d.String())
	}
	out["tdfDiagnostics"] = diags
}

func describeGAF(_ *Renderer, _ string, data []byte, out map[string]any) {
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		return
	}
	out["format"] = "GAF"

	type frame struct {
		Index        int    `json:"index"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		OriginX      int    `json:"originX"`
		OriginY      int    `json:"originY"`
		Transparency int    `json:"transparency"`
		Duration     string `json:"duration"`
		Storage      string `json:"storage"`          // "raw" or "compressed"
		Layers       int    `json:"layers,omitempty"` // layer count of a composite frame
	}
	type seq struct {
		Index  int     `json:"index"`
		Name   string  `json:"name"`
		Loops  bool    `json:"loops"` // false: the game plays the sequence once
		Frames []frame `json:"frames"`
	}

	seqs := make([]seq, 0, len(sequences))
	for i, s := range sequences {
		sq := seq{Index: i, Name: s.Name, Loops: s.Loops()}
		for j, f := range s.Frames {
			// The game shows a frame for max(duration, 1) ticks of 1/30 s.
			ticks := f.DisplayTicks()
			sq.Frames = append(sq.Frames, frame{
				Index:        j,
				Width:        int(f.Width),
				Height:       int(f.Height),
				OriginX:      int(f.OriginX),
				OriginY:      int(f.OriginY),
				Transparency: int(f.TransparencyIndex),
				Duration:     fmt.Sprintf("%d ticks (%.2fs)", ticks, float64(ticks)/gaf.TicksPerSecond),
				Storage:      f.Storage.String(),
				Layers:       len(f.Layers),
			})
		}
		seqs = append(seqs, sq)
	}
	out["sequences"] = seqs
}

func describePCX(_ *Renderer, _ string, data []byte, out map[string]any) {
	reader, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	out["format"] = "PCX"
	out["width"] = reader.Width()
	out["height"] = reader.Height()
	out["bitsPerPixel"] = reader.BitsPerPixel()
	out["colorPlanes"] = reader.Header().NumPlanes
	out["gameCompat"] = pcxGameCompat(reader.Compat())
}

// pcxCompatIssue is one way a PCX departs from what TA 3.1c expects.
type pcxCompatIssue struct {
	Code     string `json:"code"`
	Severity string `json:"severity"` // "warning" or "error"
	Message  string `json:"message"`
}

// pcxCompat is what TA 3.1c will do with a PCX: whether it loads it, and
// whether it draws it as a standard reader (the explorer's preview) does.
type pcxCompat struct {
	Loads  bool             `json:"loads"`
	OK     bool             `json:"ok"`
	Issues []pcxCompatIssue `json:"issues"`
}

func pcxGameCompat(rep pcx.CompatReport) pcxCompat {
	out := pcxCompat{Loads: rep.GameLoads(), OK: rep.OK(), Issues: []pcxCompatIssue{}}
	for _, issue := range rep.Issues {
		out.Issues = append(out.Issues, pcxCompatIssue{
			Code:     string(issue.Code),
			Severity: issue.Severity.String(),
			Message:  issue.Message,
		})
	}
	return out
}
