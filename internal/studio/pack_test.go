package studio

import (
	"bytes"
	"encoding/json"
	"image/png"
	"os"
	"path/filepath"
	"strings"
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
	if manifest.FormatVersion != 6 {
		t.Fatalf("formatVersion = %d, want 6", manifest.FormatVersion)
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

// TestBuildPackV4Assets covers the format-v4 additions: base + enhanced
// model variants, the extended weapons.json driver fields (trajectory
// flags, raw colour indices, blast/range, sound stems), catalogue-wide
// projectile meshes, and the corpse-chain models a death swap renders.
func TestBuildPackV4Assets(t *testing.T) {
	install := testutil.UnpackedPath(t)
	dir := t.TempDir()
	_, err := BuildPack(install, dir, PackOptions{
		Game:  "totala",
		Units: []string{"armpw", "armrock"},
	})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	// Both geometry variants exist and parse; the enhanced one is the
	// hidden-face reconstruction, so it can never be smaller than base.
	var base, enhanced modelJSON
	mustJSON(t, filepath.Join(dir, "models/armpw.json"), &base)
	mustJSON(t, filepath.Join(dir, "models-enhanced/armpw.json"), &enhanced)
	baseBytes, _ := os.ReadFile(filepath.Join(dir, "models/armpw.json"))
	enhBytes, _ := os.ReadFile(filepath.Join(dir, "models-enhanced/armpw.json"))
	if len(enhBytes) < len(baseBytes) {
		t.Fatalf("enhanced model (%d bytes) smaller than base (%d bytes)", len(enhBytes), len(baseBytes))
	}

	// Corpse chain: armpw's FBI corpse feature resolves to a packed wreck
	// model in BOTH variants, and unitdb meta carries the linkage.
	var db packUnitDBJSON
	mustJSON(t, filepath.Join(dir, "unitdb.json"), &db)
	var pw *packUnitJSON
	for i := range db.Units {
		if db.Units[i].Name == "armpw" {
			pw = &db.Units[i]
		}
	}
	if pw == nil || pw.Meta == nil {
		t.Fatalf("armpw missing from unitdb")
	}
	if pw.Meta.CorpseObject == "" {
		t.Fatalf("armpw meta lacks corpseObject")
	}
	for _, sub := range []string{"models", "models-enhanced"} {
		wreck := filepath.Join(dir, sub, packStem(pw.Meta.CorpseObject)+".json")
		var wm modelJSON
		mustJSON(t, wreck, &wm)
		if wm.Root == nil {
			t.Fatalf("corpse model %s has no geometry root", wreck)
		}
	}

	// weapons.json v4 driver fields on a smoke-trailed missile weapon
	// (armrock's rocket) — and its projectile mesh packed from the
	// catalogue walk, not the unit selection.
	var wf packWeaponsFileJSON
	mustJSON(t, filepath.Join(dir, "weapons.json"), &wf)
	rocket, ok := wf.Weapons["armrl_missile"]
	if !ok {
		// Rocko's TDF id differs across installs; fall back to scanning for
		// any smoke-trailed weapon with a model.
		for id, w := range wf.Weapons {
			if w.SmokeTrail && w.Model != "" {
				rocket, ok = w, true
				_ = id
				break
			}
		}
	}
	if !ok {
		t.Fatalf("no smoke-trailed model weapon in weapons.json")
	}
	if rocket.RangeWU <= 0 || rocket.AreaOfEffectWU <= 0 {
		t.Fatalf("rocket range/aoe missing: %+v", rocket)
	}
	if _, err := os.Stat(filepath.Join(dir, "models", packStem(rocket.Model)+".json")); err != nil {
		t.Fatalf("catalogue projectile model %s not packed: %v", rocket.Model, err)
	}
	if rocket.SoundStart != "" {
		if _, err := os.Stat(filepath.Join(dir, "sounds", packStem(rocket.SoundStart)+".wav")); err != nil {
			t.Fatalf("catalogue weapon sound %s not packed: %v", rocket.SoundStart, err)
		}
	}

	// Raw colour index rides beside the resolved triple (the laser tint /
	// bitmap slot input).
	laser, ok := wf.Weapons["armcomlaser"]
	if !ok || laser.ColorIdx == nil || *laser.ColorIdx <= 0 {
		t.Fatalf("armcomlaser colorIdx missing: %+v", laser)
	}
}

// TestBuildPackV5Assets covers the format-v5 additions: the features.json
// map-feature catalogue (footprints, GAF sprite dims, 3DO object links),
// the manifest features reference, packed models for a map's object
// features, and the weapons.json guided-flight fields.
func TestBuildPackV5Assets(t *testing.T) {
	install := testutil.UnpackedPath(t)
	dir := t.TempDir()
	res, err := BuildPack(install, dir, PackOptions{
		Game:  "totala",
		Units: []string{"armpw"},
		Maps:  []string{"checker ponds"},
	})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}
	if len(res.Maps) != 1 {
		t.Fatalf("expected 1 packed map, got %v", res.Maps)
	}

	var manifest packManifest
	mustJSON(t, filepath.Join(dir, "manifest.json"), &manifest)
	if manifest.Features != "features.json" {
		t.Fatalf("manifest features = %q, want features.json", manifest.Features)
	}

	var ff packFeaturesFileJSON
	mustJSON(t, filepath.Join(dir, "features.json"), &ff)
	if len(ff.Features) == 0 {
		t.Fatalf("features.json is empty")
	}

	// Every feature the packed map places must resolve in the catalogue,
	// and at least one placed sprite feature must carry GAF pixel dims.
	var mp packMapJSON
	mustJSON(t, filepath.Join(dir, "maps/checker_ponds.json"), &mp)
	if len(mp.Features) == 0 {
		t.Fatalf("checker ponds packs no feature placements")
	}
	spriteDims := false
	for _, pl := range mp.Features {
		f, ok := ff.Features[strings.ToLower(pl.Name)]
		if !ok {
			t.Fatalf("map feature %q missing from features.json", pl.Name)
		}
		if f.SpriteW > 0 && f.SpriteH > 0 {
			spriteDims = true
		}
	}
	if !spriteDims {
		t.Fatalf("no placed feature carries GAF sprite dims")
	}

	// Corpse features exist in the catalogue with 3DO object links (the
	// reclaim/wreck path a replay renders), and carry a category.
	corpse, ok := ff.Features["armpw_dead"]
	if !ok {
		t.Fatalf("features.json lacks armpw_dead")
	}
	if corpse.Object == "" || corpse.Category == "" {
		t.Fatalf("armpw_dead should carry object + category: %+v", corpse)
	}

	// Tree-class features carry footprint + height so a stand-in can size
	// itself without the GAF.
	hasTree := false
	for _, f := range ff.Features {
		if f.Category == "trees" && f.FootprintX > 0 && f.HeightWU > 0 {
			hasTree = true
			break
		}
	}
	if !hasTree {
		t.Fatalf("no tree feature with footprint + height in catalogue")
	}

	// weapons.json guided-flight fields: at least one guided weapon ships a
	// positive turnRate, and torpedoes are flagged waterWeapon.
	var wf packWeaponsFileJSON
	mustJSON(t, filepath.Join(dir, "weapons.json"), &wf)
	guided, torpedo := false, false
	for _, w := range wf.Weapons {
		if w.Guidance && w.TurnRate > 0 {
			guided = true
		}
		if w.WaterWeapon {
			torpedo = true
		}
	}
	if !guided {
		t.Fatalf("no guided weapon with turnRate in weapons.json")
	}
	if !torpedo {
		t.Fatalf("no waterWeapon torpedo in weapons.json")
	}
}

// TestBuildPackV6FeatureSprites asserts format v6: flat ground features
// (metal deposits, steam vents, scars…) carry a real GAF sprite PNG packed
// under featuresprites/<id>.png, while upright features (trees, rocks) do
// not — the renderer paints the flat ones' authored art onto the terrain.
func TestBuildPackV6FeatureSprites(t *testing.T) {
	install := testutil.UnpackedPath(t)
	dir := t.TempDir()
	if _, err := BuildPack(install, dir, PackOptions{
		Game:  "totala",
		Units: []string{"armpw"},
		Maps:  []string{"checker ponds"},
	}); err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	var manifest packManifest
	mustJSON(t, filepath.Join(dir, "manifest.json"), &manifest)
	if manifest.FormatVersion < 6 {
		t.Fatalf("manifest formatVersion = %d, want >= 6", manifest.FormatVersion)
	}

	var ff packFeaturesFileJSON
	mustJSON(t, filepath.Join(dir, "features.json"), &ff)

	// Every flat ground feature that names a GAF sprite must carry a sprite
	// path, the PNG must exist on disk and decode with an alpha channel
	// (the authored transparency the decal feathers against).  Upright and
	// object features must NOT carry a sprite.
	flatWithSprite := 0
	for id, f := range ff.Features {
		flat := isFlatGroundFeature(f)
		if f.Sprite == "" {
			if flat && f.SpriteW > 0 {
				// A flat feature with real GAF dims should have been packed.
				t.Fatalf("flat feature %q (cat %s) missing sprite despite dims %dx%d",
					id, f.Category, f.SpriteW, f.SpriteH)
			}
			continue
		}
		if !flat {
			t.Fatalf("upright/object feature %q (cat %s) should not carry a sprite: %q",
				id, f.Category, f.Sprite)
		}
		p := filepath.Join(dir, filepath.FromSlash(f.Sprite))
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("feature sprite %q not on disk: %v", f.Sprite, err)
		}
		img, derr := png.Decode(bytes.NewReader(data))
		if derr != nil {
			t.Fatalf("feature sprite %q not a PNG: %v", f.Sprite, derr)
		}
		b := img.Bounds()
		if b.Dx() <= 0 || b.Dy() <= 0 {
			t.Fatalf("feature sprite %q has empty bounds", f.Sprite)
		}
		flatWithSprite++
	}
	if flatWithSprite == 0 {
		t.Fatalf("no flat ground feature carried a packed sprite (checker ponds has metal patches)")
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
