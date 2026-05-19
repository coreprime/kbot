// Package palettepick resolves which TA / TA: Kingdoms palette should be used
// to render a given GAF.
//
// Total Annihilation ships a single global palette (palettes/palette.pal) and
// every GAF in the install renders against it. TA: Kingdoms reuses the GAF
// container format but splits the palette out by asset: interface GAFs ship
// alongside a same-name .pcx whose embedded 256-color table is the GAF's
// palette, while unit/feature GAFs use a side-specific palette (one of
// aramon / taros / veruna / zhon for the base game, plus aiden / creon from
// the Iron Plague expansion).
//
// Resolve performs the lookup in the order kbot considers most reliable:
//
//  1. Caller-supplied override path (e.g. from a UI selector or --palette flag).
//  2. Same-name .pcx adjacent to the GAF (TAK's documented convention).
//  3. Same-base-name .pal under palettes/ (covers oddities like
//     palettes/<gafname>.pal).
//  4. Side prefix heuristic on the GAF basename — ara*/tar*/ver*/zon*/aid*/cre*
//     map to the four kingdoms + the two Iron Plague factions.
//  5. palettes/palette.pal from the VFS (matches what TA shipped).
//  6. The embedded TA palette as a last-resort fallback.
//
// Resolve never returns a nil palette: it always at least surfaces the
// embedded fallback.
package palettepick

import (
	"bytes"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/internal/assets"
)

// VFS is the subset of a virtual filesystem the resolver needs. Both the
// explorer/MCP VFS and a simple on-disk reader can satisfy it.
type VFS interface {
	ReadFile(path string) ([]byte, error)
}

// Source identifies which lookup step produced the resolved palette. The
// strings are stable and short so they can be embedded in cache keys.
type Source string

const (
	SourceOverride    Source = "override"
	SourceSidecarPCX  Source = "sidecar-pcx"
	SourceSidecarPAL  Source = "sidecar-pal"
	SourceSidePalette Source = "side"
	SourceGlobal      Source = "global"
	SourceEmbedded    Source = "embedded"
)

// Result captures the palette plus enough provenance for diagnostics, cache
// keys, and UI labels.
type Result struct {
	Palette *gaf.Palette
	Source  Source
	// Path is the VFS path the palette came from, or empty for the embedded
	// fallback. For SourceSidecarPCX it's the .pcx that supplied the palette;
	// for SourceSidePalette it's e.g. "palettes/aramon.pcx".
	Path string
	// Label is a short human-readable description suitable for surfacing in
	// the UI (e.g. "aramon", "actionbuttons.pcx", "palette.pal").
	Label string
}

// sidePrefixes maps a GAF basename prefix to the palettes/ entry that supplies
// that side's colors. Order matters when prefixes share a leading letter; the
// list is short enough that linear search is fine.
var sidePrefixes = []struct {
	prefix string
	side   string
	path   string
}{
	{"ara", "aramon", "palettes/aramon.pcx"},
	{"tar", "taros", "palettes/taros.pcx"},
	{"ver", "veruna", "palettes/veruna.pcx"},
	{"zon", "zhon", "palettes/zhon.pcx"},
	{"aid", "aiden", "palettes/aiden.pcx"},
	{"cre", "creon", "palettes/creon.pcx"},
}

// Candidate is a labelled palette source the UI can offer to the user. It
// describes a palette without loading it.
type Candidate struct {
	// Path is the VFS path (empty for the embedded sentinel).
	Path string
	// Label is the short human-readable name.
	Label string
	// Source is the lookup category this candidate would be classified as.
	Source Source
}

// Candidates returns the full menu of palettes that make sense for gafPath:
// the auto-resolved default first, then every available palettes/*.{pal,pcx}
// the VFS exposes, ending with the embedded fallback. The list is suitable
// for populating a palette picker dropdown.
//
// Auto-resolution failures don't propagate — if the auto pick errors out, it's
// simply omitted from the menu (the embedded sentinel is always present).
func Candidates(vfs VFS, gafPath string) []Candidate {
	seen := map[string]bool{}
	var out []Candidate

	add := func(c Candidate) {
		key := c.Source.String() + "|" + c.Path
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, c)
	}

	// Auto pick goes first so the UI can default to it.
	if r, err := Resolve(vfs, gafPath, ""); err == nil {
		add(Candidate{Path: r.Path, Label: "auto — " + r.Label, Source: r.Source})
	}

	// Sidecar PCX next to the GAF.
	if gafPath != "" {
		base := strings.TrimSuffix(path.Base(gafPath), path.Ext(gafPath))
		pcxPath := path.Join(path.Dir(gafPath), base+".pcx")
		if vfs != nil {
			if _, err := vfs.ReadFile(pcxPath); err == nil {
				add(Candidate{Path: pcxPath, Label: base + ".pcx", Source: SourceSidecarPCX})
			}
		}
	}

	// Side palettes (only those that actually exist in this VFS).
	for _, s := range sidePrefixes {
		if vfs == nil {
			break
		}
		if _, err := vfs.ReadFile(s.path); err == nil {
			add(Candidate{Path: s.path, Label: s.side, Source: SourceSidePalette})
		}
	}

	// Global palette if present.
	if vfs != nil {
		if _, err := vfs.ReadFile("palettes/palette.pal"); err == nil {
			add(Candidate{Path: "palettes/palette.pal", Label: "palette.pal", Source: SourceGlobal})
		}
	}

	// Embedded fallback.
	add(Candidate{Path: "", Label: "embedded TA palette", Source: SourceEmbedded})
	return out
}

// Resolve returns the palette that should be used to render gafPath. If
// override is non-empty it is loaded directly (and failures bubble up). A
// caller passing override == "" gets the documented auto-detection chain.
//
// vfs may be nil — in that case auto-detection skips every VFS-based step and
// falls back to the embedded palette.
func Resolve(vfs VFS, gafPath, override string) (Result, error) {
	if override != "" {
		if vfs == nil {
			return Result{}, fmt.Errorf("palette override %q given but no VFS to read it from", override)
		}
		pal, label, err := loadPaletteFromPath(vfs, override)
		if err != nil {
			return Result{}, fmt.Errorf("load override palette %s: %w", override, err)
		}
		return Result{Palette: pal, Source: SourceOverride, Path: override, Label: label}, nil
	}

	if vfs != nil && gafPath != "" {
		dir := path.Dir(gafPath)
		base := strings.TrimSuffix(path.Base(gafPath), path.Ext(gafPath))

		// 1. Same-name .pcx adjacent (TAK's documented convention).
		pcxPath := path.Join(dir, base+".pcx")
		if pal, err := tryPCXPalette(vfs, pcxPath); err == nil && pal != nil {
			return Result{Palette: pal, Source: SourceSidecarPCX, Path: pcxPath, Label: base + ".pcx"}, nil
		}

		// 2. Same-base .pal in palettes/.
		palPath := "palettes/" + base + ".pal"
		if pal, err := tryPALPalette(vfs, palPath); err == nil && pal != nil {
			return Result{Palette: pal, Source: SourceSidecarPAL, Path: palPath, Label: base + ".pal"}, nil
		}

		// 3. Side prefix heuristic.
		lower := strings.ToLower(base)
		for _, s := range sidePrefixes {
			if !strings.HasPrefix(lower, s.prefix) {
				continue
			}
			if pal, err := tryPCXPalette(vfs, s.path); err == nil && pal != nil {
				return Result{Palette: pal, Source: SourceSidePalette, Path: s.path, Label: s.side}, nil
			}
			break // matched prefix but file missing — don't try other sides
		}

		// 4. palettes/palette.pal from VFS.
		if pal, err := tryPALPalette(vfs, "palettes/palette.pal"); err == nil && pal != nil {
			return Result{Palette: pal, Source: SourceGlobal, Path: "palettes/palette.pal", Label: "palette.pal"}, nil
		}
	}

	// 5. Embedded fallback.
	pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		return Result{}, fmt.Errorf("load embedded palette: %w", err)
	}
	return Result{Palette: pal, Source: SourceEmbedded, Label: "embedded TA palette"}, nil
}

// String returns the Source as a stable identifier for cache keys / logs.
func (s Source) String() string { return string(s) }

func tryPCXPalette(vfs VFS, p string) (*gaf.Palette, error) {
	data, err := vfs.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return paletteFromPCX(data)
}

func tryPALPalette(vfs VFS, p string) (*gaf.Palette, error) {
	data, err := vfs.ReadFile(p)
	if err != nil {
		return nil, err
	}
	return paletteFromPAL(data)
}

func paletteFromPCX(data []byte) (*gaf.Palette, error) {
	r, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	pal := r.EmbeddedPalette()
	if pal == nil {
		return nil, errors.New("pcx has no embedded palette")
	}
	return pal, nil
}

func paletteFromPAL(data []byte) (*gaf.Palette, error) {
	return gaf.LoadPaletteFromBytes(data)
}

// loadPaletteFromPath chooses .pal vs .pcx based on the path extension, with a
// fallback that tries both if the extension is unrecognised.
func loadPaletteFromPath(vfs VFS, p string) (*gaf.Palette, string, error) {
	label := path.Base(p)
	ext := strings.ToLower(path.Ext(p))
	switch ext {
	case ".pcx":
		pal, err := tryPCXPalette(vfs, p)
		return pal, label, err
	case ".pal":
		pal, err := tryPALPalette(vfs, p)
		return pal, label, err
	}
	// Unknown extension: try PAL first (1024 bytes), then PCX.
	if pal, err := tryPALPalette(vfs, p); err == nil {
		return pal, label, nil
	}
	pal, err := tryPCXPalette(vfs, p)
	return pal, label, err
}
