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
	}
	type seq struct {
		Index  int     `json:"index"`
		Name   string  `json:"name"`
		Frames []frame `json:"frames"`
	}

	seqs := make([]seq, 0, len(sequences))
	for i, s := range sequences {
		sq := seq{Index: i, Name: s.Name}
		for j, f := range s.Frames {
			sq.Frames = append(sq.Frames, frame{
				Index:        j,
				Width:        int(f.Width),
				Height:       int(f.Height),
				OriginX:      int(f.OriginX),
				OriginY:      int(f.OriginY),
				Transparency: int(f.TransparencyIndex),
				Duration:     fmt.Sprintf("%d ticks (%.2fs)", f.Duration, float64(f.Duration)/30.0),
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
}
