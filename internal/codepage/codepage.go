// Package codepage converts UTF-8 text to the single-byte code pages Total
// Annihilation's bitmap fonts are indexed by.
//
// The game draws text byte by byte: each byte selects the font glyph with
// that code. The retail game's text is Windows-1252 (Western), so that is
// the default; localised installs and mods may use another code page.
package codepage

import (
	"fmt"
	"sort"
	"strings"

	"golang.org/x/text/encoding/charmap"

	"github.com/coreprime/kbot-io/formats/fnt"
)

// Default is the code page of the retail game's text.
const Default = "cp1252"

// Raw names the pass-through "code page": the text's bytes are used as they
// are, for text already in the font's encoding.
const Raw = "raw"

// charmaps are the supported code pages other than Default and Raw.
var charmaps = map[string]*charmap.Charmap{
	"cp1250":      charmap.Windows1250,
	"cp1251":      charmap.Windows1251,
	"cp437":       charmap.CodePage437,
	"cp850":       charmap.CodePage850,
	"iso-8859-1":  charmap.ISO8859_1,
	"iso-8859-15": charmap.ISO8859_15,
}

// aliases map alternative spellings to the canonical names.
var aliases = map[string]string{
	"windows-1252": Default, "1252": Default,
	"windows-1250": "cp1250", "1250": "cp1250",
	"windows-1251": "cp1251", "1251": "cp1251",
	"437": "cp437", "850": "cp850",
	"latin1": "iso-8859-1", "latin-1": "iso-8859-1",
	"latin9": "iso-8859-15", "latin-9": "iso-8859-15",
	"bytes": Raw,
}

// Names lists the accepted code page names.
func Names() []string {
	out := []string{Default, Raw}
	for n := range charmaps {
		out = append(out, n)
	}
	sort.Strings(out[2:])
	return out
}

// Encode converts UTF-8 text to one byte per character in the named code
// page (Default when name is empty), ready for fnt.Font.RenderText.
// Characters the code page has no byte for become '?'. Raw returns the
// text's bytes unchanged.
func Encode(name, text string) (string, error) {
	n := strings.ToLower(strings.TrimSpace(name))
	if a, ok := aliases[n]; ok {
		n = a
	}
	switch n {
	case "", Default:
		return fnt.EncodeCP1252(text), nil
	case Raw:
		return text, nil
	}
	cm, ok := charmaps[n]
	if !ok {
		return "", fmt.Errorf("unknown code page %q (want one of %s)", name, strings.Join(Names(), ", "))
	}
	var b strings.Builder
	for _, r := range text {
		if c, ok := cm.EncodeRune(r); ok {
			b.WriteByte(c)
		} else {
			b.WriteByte('?')
		}
	}
	return b.String(), nil
}
