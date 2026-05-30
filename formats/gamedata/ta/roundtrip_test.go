package ta

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/gamedata/common"
	"github.com/coreprime/kbot/formats/tdf"
)

// taRoot returns the unpacked TA 3.1 game directory, or "" to skip.
func taRoot() string { return os.Getenv("TA_UNPACKED_PATH") }

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
// contains an embedded newline/tab or a second "key=" assignment. The lone
// exception is weaponacceleration="13O" (letter O for zero) in the stock
// weapons, a single-token typo with no such marker.
func knownDirtyData(leak string) bool {
	eq := strings.IndexByte(leak, '=')
	if eq < 0 {
		return false
	}
	val := leak[eq+1:]
	if strings.ContainsAny(val, "\n\t") || strings.Contains(val, "=") {
		return true
	}
	return strings.EqualFold(leak, "Weapon.weaponacceleration=13O")
}

func rel(root, path string) string {
	if r, err := filepath.Rel(root, path); err == nil {
		return r
	}
	return path
}

func TestRoundTripWeapons(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	exts := map[string]bool{".tdf": true}
	// gamedata/weapons.tdf and any standalone weapons/*.tdf are []Weapon.
	roundTripDir(t, root, "weapons", exts, func() any { return &[]Weapon{} })
	data, err := os.ReadFile(filepath.Join(root, "gamedata", "weapons.tdf"))
	if err != nil {
		t.Skipf("gamedata/weapons.tdf: %v", err)
	}
	var weps []Weapon
	if err := tdf.Unmarshal(data, &weps); err != nil {
		t.Fatalf("weapons.tdf: unmarshal: %v", err)
	}
	out, err := tdf.Marshal(weps)
	if err != nil {
		t.Fatalf("weapons.tdf: marshal: %v", err)
	}
	if ok, msg := tdf.SemanticEqual(data, out); !ok {
		t.Errorf("gamedata/weapons.tdf: %s", msg)
	}
}

func TestRoundTripUnits(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripDir(t, root, "units", map[string]bool{".fbi": true}, func() any { return &Unit{} })
}

func TestRoundTripFeatures(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripDir(t, root, "features", map[string]bool{".tdf": true}, func() any { return &[]Feature{} })
}

func TestRoundTripGUIs(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripDir(t, root, "guis", map[string]bool{".gui": true}, func() any { return &[]Gadget{} })
}

func TestRoundTripMaps(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	// .ota files live under maps/ (and possibly elsewhere); scan the whole tree.
	roundTripDir(t, root, ".", map[string]bool{".ota": true}, func() any { return &Map{} })
}

// roundTripFile decodes a single named gamedata file into a fresh value from
// newv, re-marshals it, and asserts semantic equality with the original.
func roundTripFile(t *testing.T, root, name string, newv func() any) {
	t.Helper()
	path := filepath.Join(root, "gamedata", name)
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

// roundTripFileAt is like roundTripFile but takes a path relative to the game
// root rather than to gamedata/.
func roundTripFileAt(t *testing.T, root, rel string, newv func() any) {
	t.Helper()
	path := filepath.Join(root, rel)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("%s: %v", rel, err)
	}
	v := newv()
	if err := tdf.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: unmarshal: %v", rel, err)
	}
	out, err := tdf.Marshal(v)
	if err != nil {
		t.Fatalf("%s: marshal: %v", rel, err)
	}
	if ok, msg := tdf.SemanticEqual(data, out); !ok {
		t.Errorf("%s: %s", rel, msg)
	}
}

func TestRoundTripMoveInfo(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, "moveinfo.tdf", func() any { return &[]MovementClass{} })
}

func TestRoundTripCategories(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, "category.tdf", func() any { return &[]Category{} })
}

func TestRoundTripMeteor(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, "meteor.tdf", func() any { return &[]Meteor{} })
}

func TestRoundTripSounds(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, "sound.tdf", func() any { return &[]SoundClass{} })
	roundTripFile(t, root, "allsound.tdf", func() any { return &[]SoundEvent{} })
}

func TestRoundTripSideData(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	roundTripFile(t, root, "sidedata.tdf", func() any { return &[]Side{} })
}

// TestRoundTripGeneric covers the dynamic-key config and dictionary formats that
// have no fixed schema worth enumerating (keyboard help, LOS tables, string
// translations, build/version stamps, campaign and download manifests). They
// round-trip through the generic common.Section model.
func TestRoundTripGeneric(t *testing.T) {
	root := taRoot()
	if root == "" {
		t.Skip("TA_UNPACKED_PATH not set")
	}
	sec := func() any { return &[]common.Section{} }
	for _, name := range []string{
		"buildinfo.tdf", "help.tdf", "los.tdf",
		"translate.tdf", "unitview.tdf", "version.tdf",
	} {
		roundTripFile(t, root, name, sec)
	}
	tdfOnly := map[string]bool{".tdf": true}
	roundTripDir(t, root, "camps", tdfOnly, sec)
	roundTripDir(t, root, "download", tdfOnly, sec)
	// Stray campaign/multiplayer manifests living outside gamedata/.
	roundTripFileAt(t, root, "example.tdf", sec)
	roundTripFileAt(t, root, filepath.Join("maps", "multiplay.tdf"), sec)
}
