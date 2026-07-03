package studio

import (
	"bytes"
	"encoding/json"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/internal/testutil"
)

// TestBuildPackDeterministic packs the same small unit set twice from the
// real TA install and asserts the two packs are byte-identical (same
// content hash AND same bytes per file) — the property the replayer's
// recording ↔ pack matching keys on.
func TestBuildPackDeterministic(t *testing.T) {
	install := testutil.UnpackedPath(t)

	build := func(dir string) *PackResult {
		res, err := BuildPack(install, dir, PackOptions{
			Game:  "totala",
			Units: []string{"armcom", "armpw"},
		})
		if err != nil {
			t.Fatalf("BuildPack: %v", err)
		}
		return res
	}
	dirA := filepath.Join(t.TempDir(), "a")
	dirB := filepath.Join(t.TempDir(), "b")
	resA := build(dirA)
	resB := build(dirB)

	if resA.Hash != resB.Hash {
		t.Fatalf("content hash differs between identical builds:\n  %s\n  %s", resA.Hash, resB.Hash)
	}
	if resA.FileCount != resB.FileCount {
		t.Fatalf("file count differs: %d vs %d", resA.FileCount, resB.FileCount)
	}

	// Byte-compare every file, not just the rollup hash.
	err := filepath.Walk(dirA, func(pathA string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dirA, pathA)
		a, err := os.ReadFile(pathA)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(filepath.Join(dirB, rel))
		if err != nil {
			t.Fatalf("file %s missing from second build: %v", rel, err)
		}
		if string(a) != string(b) {
			t.Fatalf("file %s differs between identical builds", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
}

// TestBuildPackContents asserts the pack carries the pieces the
// HttpPackProvider contract needs for a unit: manifest, unitdb entry with
// movement class + build fields, model geometry, at least one texture and
// the COB script.
func TestBuildPackContents(t *testing.T) {
	install := testutil.UnpackedPath(t)
	dir := t.TempDir()
	res, err := BuildPack(install, dir, PackOptions{
		Game:  "totala",
		Units: []string{"armcom"},
	})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}
	if len(res.Units) != 1 || res.Units[0] != "armcom" {
		t.Fatalf("unexpected unit selection: %v", res.Units)
	}

	var manifest packManifest
	mustJSON(t, filepath.Join(dir, "manifest.json"), &manifest)
	if manifest.Format != "kbot-pack" || manifest.Game != "totala" {
		t.Fatalf("manifest identity wrong: %+v", manifest)
	}
	if manifest.ContentHash != res.Hash {
		t.Fatalf("manifest hash %s != result hash %s", manifest.ContentHash, res.Hash)
	}
	if manifest.GameUnitCount <= manifest.UnitCount {
		t.Fatalf("gameUnitCount (%d) should exceed the packed subset (%d)", manifest.GameUnitCount, manifest.UnitCount)
	}

	var db packUnitDBJSON
	mustJSON(t, filepath.Join(dir, "unitdb.json"), &db)
	if len(db.Units) != 1 {
		t.Fatalf("expected 1 unitdb entry, got %d", len(db.Units))
	}
	u := db.Units[0]
	if u.Name != "armcom" || u.ID <= 0 {
		t.Fatalf("bad unit identity: %+v", u)
	}
	if u.MovementClass == "" {
		t.Fatalf("armcom should carry its FBI movementClass")
	}
	if u.MotionDomain != "ground" {
		t.Fatalf("armcom motionDomain = %q, want ground", u.MotionDomain)
	}
	if u.Meta == nil || u.Meta.BuildTime <= 0 || u.Meta.MaxDamage <= 0 {
		t.Fatalf("armcom meta missing build/hp fields: %+v", u.Meta)
	}

	for _, rel := range []string{
		"palette.json",
		"models/armcom.json",
		"cob/armcom.json",
		"cob/armcom.cob",
		"README.md",
	} {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			t.Fatalf("pack missing %s: %v", rel, err)
		}
	}

	// The raw COB is the RUNNABLE form: it must point from the unitdb entry
	// and parse through the same loader the engine's script VM uses, with a
	// real script table (Create/StartMoving live here).
	if u.CobBin != "cob/armcom.cob" {
		t.Fatalf("unitdb cobBin = %q, want cob/armcom.cob", u.CobBin)
	}
	rawCob, err := os.ReadFile(filepath.Join(dir, "cob/armcom.cob"))
	if err != nil {
		t.Fatalf("read raw cob: %v", err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(rawCob))
	if err != nil {
		t.Fatalf("packed cob does not parse: %v", err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatalf("packed cob does not compile into a VM program: %v", err)
	}
	for _, want := range []string{"Create", "StartMoving", "StopMoving", "AimPrimary", "FirePrimary"} {
		if !prog.HasScript(want) {
			t.Fatalf("armcom program lacks the %s entry point", want)
		}
	}

	// The commander's model must reference at least one texture that the
	// pack actually shipped.
	var model modelJSON
	mustJSON(t, filepath.Join(dir, "models/armcom.json"), &model)
	if len(model.Textures) == 0 {
		t.Fatalf("armcom model lists no textures")
	}
	found := false
	for _, tex := range model.Textures {
		if _, err := os.Stat(filepath.Join(dir, "textures", packStem(tex)+".png")); err == nil {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("none of armcom's textures were packed: %v", model.Textures)
	}
}

// TestBuildPackV3Assets covers the format-v3 additions: the unit build
// picture (unitpics/<name>.png + unitdb unitPic), the weapons.json render
// catalogue (manifest weapons ref, palette-resolved colours) and the
// unitdb slot-ordered weapons array a replayer maps WeaponFire slots with.
func TestBuildPackV3Assets(t *testing.T) {
	install := testutil.UnpackedPath(t)
	dir := t.TempDir()
	_, err := BuildPack(install, dir, PackOptions{
		Game:  "totala",
		Units: []string{"armcom"},
	})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	var manifest packManifest
	mustJSON(t, filepath.Join(dir, "manifest.json"), &manifest)
	if manifest.FormatVersion != 3 {
		t.Fatalf("formatVersion = %d, want 3", manifest.FormatVersion)
	}
	if manifest.Weapons != "weapons.json" {
		t.Fatalf("manifest weapons = %q, want weapons.json", manifest.Weapons)
	}

	// Build picture: a real PNG at native (non-zero) size.
	picFile, err := os.Open(filepath.Join(dir, "unitpics", "armcom.png"))
	if err != nil {
		t.Fatalf("open build pic: %v", err)
	}
	defer func() { _ = picFile.Close() }()
	img, err := png.Decode(picFile)
	if err != nil {
		t.Fatalf("decode build pic: %v", err)
	}
	if b := img.Bounds(); b.Dx() <= 0 || b.Dy() <= 0 {
		t.Fatalf("build pic has empty bounds: %v", b)
	}

	// Weapon catalogue: armcom's laser must resolve with a beam colour.
	var wf packWeaponsFileJSON
	mustJSON(t, filepath.Join(dir, "weapons.json"), &wf)
	if len(wf.Weapons) == 0 {
		t.Fatalf("weapons.json is empty")
	}
	laser, ok := wf.Weapons["armcomlaser"]
	if !ok {
		t.Fatalf("weapons.json lacks armcomlaser (%d entries)", len(wf.Weapons))
	}
	if laser.ID != "armcomlaser" || laser.RenderType != 0 || !laser.BeamWeapon {
		t.Fatalf("armcomlaser fields wrong: %+v", laser)
	}
	if laser.Name == "" {
		t.Fatalf("armcomlaser should carry its TDF name")
	}
	if laser.Color == nil {
		t.Fatalf("armcomlaser color= should resolve to an RGB triple")
	}
	// TDF color=232 — a green in TA's palette; assert the resolution really
	// went through the palette rather than echoing the raw index.
	if laser.Color[1] == 0 {
		t.Fatalf("armcomlaser beam colour %v has no green component", *laser.Color)
	}
	if laser.VelocityWU <= 0 || laser.DurationSec <= 0 {
		t.Fatalf("armcomlaser velocity/duration missing: %+v", laser)
	}

	// unitdb: the v3 per-unit fields.
	var db packUnitDBJSON
	mustJSON(t, filepath.Join(dir, "unitdb.json"), &db)
	if len(db.Units) != 1 {
		t.Fatalf("expected 1 unitdb entry, got %d", len(db.Units))
	}
	u := db.Units[0]
	if u.UnitPic != "unitpics/armcom.png" {
		t.Fatalf("unitPic = %q, want unitpics/armcom.png", u.UnitPic)
	}
	if len(u.Weapons) == 0 || u.Weapons[0] != "armcomlaser" {
		t.Fatalf("slot-ordered weapons wrong: %v", u.Weapons)
	}
	for _, id := range u.Weapons {
		if id == "" {
			continue // interior empty slot — position padding, no catalogue entry
		}
		if _, ok := wf.Weapons[id]; !ok {
			t.Fatalf("unit weapon %q missing from weapons.json", id)
		}
	}
}

func mustJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
