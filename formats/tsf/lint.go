package tsf

import "fmt"

// LintLevel classifies the seriousness of a lint finding.
type LintLevel int

const (
	// LintError marks a problem that makes the file unusable or unserializable.
	LintError LintLevel = iota
	// LintWarning marks a suspicious-but-tolerated condition.
	LintWarning
	// LintInfo records a noteworthy, harmless observation.
	LintInfo
)

// String returns the lowercase label for the level.
func (l LintLevel) String() string {
	switch l {
	case LintError:
		return "error"
	case LintWarning:
		return "warning"
	default:
		return "info"
	}
}

// LintDiagnostic is a single finding from Lint or LintDocument. Frame is the
// zero-based frame index, or -1 for a file-level finding.
type LintDiagnostic struct {
	Level   LintLevel
	Frame   int
	Message string
}

// Lint inspects a parsed TAF for structural problems and curiosities. An empty
// result means the animation is clean and will serialize byte-cleanly.
func (t *TAF) Lint() []LintDiagnostic {
	var out []LintDiagnostic
	add := func(level LintLevel, frame int, format string, args ...any) {
		out = append(out, LintDiagnostic{Level: level, Frame: frame, Message: fmt.Sprintf(format, args...)})
	}

	if len(t.Frames) == 0 {
		add(LintError, -1, "animation has no frames")
		return out
	}
	if len(t.Frames) > 0xFFFF {
		add(LintError, -1, "frame count %d exceeds the 16-bit limit", len(t.Frames))
	}

	if t.rawNameSet {
		var canonical [nameFieldLen]byte
		writeName(canonical[:], t.Name)
		if t.nameField != canonical {
			add(LintInfo, -1, "name field carries %d bytes of buffer remnants past the terminator (preserved for byte-exact round-trip)", nameFieldLen)
		}
	}

	for i, f := range t.Frames {
		if f.Width == 0 || f.Height == 0 {
			add(LintError, i, "zero dimension %dx%d", f.Width, f.Height)
		}
		if f.Format != FormatARGB4444 && f.Format != FormatARGB1555 {
			add(LintError, i, "unknown pixel format 0x%02X", uint8(f.Format))
			continue
		}
		want := int(f.Width) * int(f.Height) * f.Format.BytesPerPixel()
		if len(f.Pixels) != want {
			add(LintError, i, "pixel buffer is %d bytes, expected %d for %dx%d %s",
				len(f.Pixels), want, f.Width, f.Height, f.Format)
		}
		if f.flagB != 0 && f.flagB != 0xFF {
			add(LintWarning, i, "unexpected frame flag byte 0x%02X (retail assets use 0x00 or 0xFF)", f.flagB)
		}
	}
	return out
}

// LintDocument checks that a TSF document matches the animation shape the
// compiler expects: one animation section, each frame holding exactly one layer
// with a Filename. It does not load the referenced images.
func LintDocument(doc *Document) []LintDiagnostic {
	var out []LintDiagnostic
	add := func(level LintLevel, frame int, format string, args ...any) {
		out = append(out, LintDiagnostic{Level: level, Frame: frame, Message: fmt.Sprintf(format, args...)})
	}

	if doc == nil || len(doc.Sections) == 0 {
		add(LintError, -1, "document has no animation section")
		return out
	}
	if len(doc.Sections) > 1 {
		add(LintWarning, -1, "document has %d top-level sections; only the first is compiled", len(doc.Sections))
	}

	anim := doc.Sections[0]
	frames := anim.Subsections()
	if len(frames) == 0 {
		add(LintError, -1, "animation [%s] has no frame subsections", anim.Name)
		return out
	}

	for i, fs := range frames {
		if _, ok := fs.Get("Format"); !ok {
			add(LintInfo, i, "frame [%s] has no Format; compile defaults to ARGB4444", fs.Name)
		} else if v, _ := fs.Get("Format"); v != "" {
			if _, err := parsePixelFormat(v); err != nil {
				add(LintError, i, "frame [%s]: %v", fs.Name, err)
			}
		}

		layers := fs.Subsections()
		switch len(layers) {
		case 0:
			add(LintError, i, "frame [%s] has no layer subsection", fs.Name)
		case 1:
			if _, ok := layers[0].Get("Filename"); !ok {
				add(LintError, i, "frame [%s] layer [%s] has no Filename", fs.Name, layers[0].Name)
			}
		default:
			add(LintError, i, "frame [%s] has %d layers; the compiler supports exactly one", fs.Name, len(layers))
		}
	}
	return out
}
