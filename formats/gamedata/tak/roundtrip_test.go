package tak

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/gamedata/common"
	"github.com/coreprime/kbot/formats/tdf"
)

// takRoot returns the unpacked TA:Kingdoms game directory, or "" to skip.
func takRoot() string { return os.Getenv("TAK_UNPACKED_PATH") }

// roundTripDir decodes every file under root/sub with one of exts into a fresh
// value produced by newv, re-marshals it, and asserts the result is
// semantically equal to the original. Files containing NUL bytes (compiled
// binary blobs masquerading as text) are skipped.
func roundTripDir(t *testing.T, root, sub string, exts map[string]bool, newv func() any) {
	t.Helper()
	dir := filepath.Join(root, sub)
	var total, skipped, failed int
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !exts[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if bytes.IndexByte(data, 0) >= 0 {
			skipped++
			return nil
		}
		total++
		v := newv()
		if err := tdf.Unmarshal(data, v); err != nil {
			failed++
			if failed <= 20 {
				t.Errorf("%s: unmarshal: %v", rel(root, path), err)
			}
			return nil
		}
		out, err := tdf.Marshal(v)
		if err != nil {
			failed++
			if failed <= 20 {
				t.Errorf("%s: marshal: %v", rel(root, path), err)
			}
			return nil
		}
		if ok, msg := tdf.SemanticEqual(data, out); !ok {
			failed++
			if failed <= 20 {
				t.Errorf("%s: %s", rel(root, path), msg)
			}
		}
		for _, leak := range tdf.MisparsedKeys(v) {
			if knownDirtyData(leak) {
				continue
			}
			failed++
			if failed <= 20 {
				t.Errorf("%s: value fell through to catch-all (mis-typed field?): %s", rel(root, path), leak)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	t.Logf("%s: %d files checked, %d binary skipped, %d failed", sub, total, skipped, failed)
}

// knownDirtyData allowlists catch-all leaks caused by defects in the shipped
// game data rather than mis-typed struct fields. A mis-typed field captures a
// clean single value of the wrong type (e.g. "2, 4"); a data defect captures a
// value that swallowed the following line because a ';' is missing, so it
// contains an embedded newline/tab or a second "key=" assignment.
func knownDirtyData(leak string) bool {
	eq := strings.IndexByte(leak, '=')
	if eq < 0 {
		return false
	}
	val := leak[eq+1:]
	return strings.ContainsAny(val, "\n\t") || strings.Contains(val, "=")
}

func rel(root, path string) string {
	if r, err := filepath.Rel(root, path); err == nil {
		return r
	}
	return path
}

func TestRoundTripUnits(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	roundTripDir(t, root, "units", map[string]bool{".fbi": true}, func() any { return &Unit{} })
	// unitscb holds corpse/effect units; their [WEAPONn] sections carry the
	// tracer colour fields (innercolor/middlecolor/outercolor).
	roundTripDir(t, root, "unitscb", map[string]bool{".fbi": true}, func() any { return &Unit{} })
}

func TestRoundTripFeatures(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	roundTripDir(t, root, "features", map[string]bool{".tdf": true}, func() any { return &[]Feature{} })
}

func TestRoundTripMaps(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	// .ota files live under both maps/ and missions/; scan the whole tree.
	roundTripDir(t, root, ".", map[string]bool{".ota": true}, func() any { return &Map{} })
}

// roundTripFile decodes a single file (relative to root) into a fresh value
// from newv, re-marshals it, and asserts semantic equality with the original.
func roundTripFile(t *testing.T, root, name string, newv func() any) {
	t.Helper()
	path := filepath.Join(root, name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("%s: %v", name, err)
	}
	v := newv()
	if err := tdf.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: unmarshal: %v", name, err)
	}
	out, err := tdf.Marshal(v)
	if err != nil {
		t.Fatalf("%s: marshal: %v", name, err)
	}
	if ok, msg := tdf.SemanticEqual(data, out); !ok {
		t.Errorf("%s: %s", name, msg)
	}
}

func TestRoundTripMoveInfo(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, filepath.Join("gamedata", "moveinfo.tdf"), func() any { return &[]MovementClass{} })
}

func TestRoundTripSideData(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, filepath.Join("gamedata", "sidedata.tdf"), func() any { return &[]Side{} })
}

func TestRoundTripEffects(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, filepath.Join("gamedata", "effects", "effects.tdf"), func() any { return &[]Effect{} })
	// explosions/ and damageflames/ use numbered [0]..[n] sub-blocks rather than
	// the palette/emitters layout, so they round-trip through the generic type.
	roundTripFile(t, root, filepath.Join("gamedata", "explosions", "explosions.tdf"), func() any { return &[]common.Section{} })
	roundTripFile(t, root, filepath.Join("gamedata", "damageflames", "damageflames.tdf"), func() any { return &[]common.Section{} })
}

// TestRoundTripGeneric covers the dynamic-key config and dictionary formats with
// no fixed schema worth enumerating (AI names, god timings, interface music,
// keyboard maps, render flags, sound classes, font kerning tables, string
// translations, campaign and build-menu manifests). They round-trip through the
// generic common.Section model.
func TestRoundTripGeneric(t *testing.T) {
	root := takRoot()
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set")
	}
	sec := func() any { return &[]common.Section{} }
	for _, name := range []string{
		filepath.Join("gamedata", "ainames.tdf"),
		filepath.Join("gamedata", "gods.tdf"),
		filepath.Join("gamedata", "interface.tdf"),
		filepath.Join("gamedata", "keys.tdf"),
		filepath.Join("gamedata", "render.tdf"),
		"keys.tdf",
		"startup.tdf",
	} {
		roundTripFile(t, root, name, sec)
	}
	tdfOnly := map[string]bool{".tdf": true}
	for _, sub := range []string{
		filepath.Join("gamedata", "soundclasses"),
		"fonts", "translate", "missions", "camps",
		"canbuild", "canbuildcb",
		// maps/ also holds .ota files (covered by TestRoundTripMaps); the .tdf
		// entries here are unit-availability manifests.
		"maps",
	} {
		roundTripDir(t, root, sub, tdfOnly, sec)
	}
	// anims/*.tsf are nested animation-sequence definitions ([FrameN]/[LayerN])
	// in TDF grammar.
	roundTripDir(t, root, "anims", map[string]bool{".tsf": true}, sec)
}
