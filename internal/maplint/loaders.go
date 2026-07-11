package maplint

import (
	"strings"

	"github.com/coreprime/kbot-io/formats/tdf"
)

// ParseOTA reads a TA .ota file's text and extracts the fields the
// lint cares about.  Schemas live in nested [Schema N] sections,
// each with its own [specials] block carrying StartPos1..N entries.
// Returns nil when the file has no [GlobalHeader] (probably not an
// OTA at all).
func ParseOTA(content string) (*OTAInfo, error) {
	doc, err := tdf.ParseString(content)
	if err != nil {
		return nil, err
	}
	gh := doc.Section("GlobalHeader")
	if gh == nil {
		return nil, nil
	}
	out := &OTAInfo{
		MissionName:        gh.String("missionname"),
		MissionDescription: gh.String("missiondescription"),
		Planet:             gh.String("planet"),
		NumPlayers:         gh.String("numplayers"),
		Size:               gh.String("size"),
		SeaLevel:           gh.Int("sealevel"),
	}
	for _, sec := range gh.Sections() {
		if !strings.HasPrefix(strings.ToLower(sec.Name()), "schema") {
			continue
		}
		schema := SchemaInfo{
			Name:         strings.TrimPrefix(sec.Name(), "Schema "),
			Type:         sec.String("type"),
			SurfaceMetal: sec.Int("surfacemetal"),
		}
		if schema.Name == "" {
			schema.Name = sec.Name()
		}
		for _, child := range sec.Sections() {
			if !strings.EqualFold(child.Name(), "specials") {
				continue
			}
			for _, sp := range child.Sections() {
				what := sp.String("specialwhat")
				if !strings.HasPrefix(strings.ToLower(what), "startpos") {
					continue
				}
				num := 0
				if n, err := atoiTail(what, len("StartPos")); err == nil {
					num = n
				}
				if num <= 0 {
					continue
				}
				schema.StartPos = append(schema.StartPos, StartPos{
					Number: num,
					X:      sp.Int("xpos"),
					Z:      sp.Int("zpos"),
				})
			}
		}
		out.Schemas = append(out.Schemas, schema)
	}
	return out, nil
}

// atoiTail parses the integer suffix starting at byte offset off.
// Used for "StartPosN" → N.  Returns (n, nil) on success and (0, err)
// when the suffix isn't a non-negative integer.
func atoiTail(s string, off int) (int, error) {
	if off >= len(s) {
		return 0, errNoDigits
	}
	tail := s[off:]
	n := 0
	any := false
	for _, r := range tail {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
		any = true
	}
	if !any {
		return 0, errNoDigits
	}
	return n, nil
}

// errNoDigits is a sentinel for atoiTail — keeps the hot path
// allocation-free.
var errNoDigits = newSimpleErr("no digit suffix")

type simpleErr struct{ msg string }

func (e *simpleErr) Error() string { return e.msg }
func newSimpleErr(s string) error  { return &simpleErr{msg: s} }
