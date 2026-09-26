package gamevfs

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// file is one archive entry for writeArchive, added in order.
type file struct{ path, body string }

// writeArchive writes a version 1 archive holding files, in order. With
// noTrailer it omits the Cavedog trailer, which TA 3.1c requires.
func writeArchive(t *testing.T, path string, noTrailer bool, files ...file) {
	t.Helper()
	w, err := hpiv1.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	if noTrailer {
		w.AllowNonGameTrailer = true
		w.SetTrailer(nil)
	}
	for _, f := range files {
		if err := w.AddFileFromBytes(f.path, []byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeV2Archive(t *testing.T, path string, files ...file) {
	t.Helper()
	w, err := hpiv2.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := w.AddFileFromBytes(f.path, []byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeLoose(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// makeInstall builds a small TA-style game directory: rev31.gp3, one .ccx,
// two .ufo, eleven mountable .hpi (h01..h11), a trailerless h00.hpi and a
// TA: Kingdoms archive, plus one loose file.
func makeInstall(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeArchive(t, filepath.Join(dir, "rev31.gp3"), false,
		file{"units/armcom.fbi", "rev"},
		file{"features/urban/cars2.tdf", "[CarScar05]{filename=cars2;}"},
		file{"features/urban/cars.tdf", "[CarScar05]{filename=cars;}"},
	)
	writeArchive(t, filepath.Join(dir, "btdata.ccx"), false,
		file{"units/armcom.fbi", "ccx"},
		file{"anims/armhp1.gaf", "btdata"},
		file{"weapons/sub/deep.tdf", "[DEEP]{}"},
		file{"weapons/arm.tdf", "[ARMGUN]{}"},
	)
	writeArchive(t, filepath.Join(dir, "AFark.ufo"), false, file{"units/afark.fbi", "fark"})
	writeArchive(t, filepath.Join(dir, "zeta.ufo"), false, file{"units/zeta.fbi", "zeta"})
	for i := 1; i <= 11; i++ {
		writeArchive(t, filepath.Join(dir, fmt.Sprintf("h%02d.hpi", i)), false,
			file{fmt.Sprintf("maps/m%02d.tnt", i), "map"})
	}
	writeArchive(t, filepath.Join(dir, "h00.hpi"), true, file{"units/armcom.fbi", "no trailer"})
	writeV2Archive(t, filepath.Join(dir, "kingdoms.hpi"), file{"units/armcom.fbi", "v2"})
	writeLoose(t, dir, "gamedata/sidedata.tdf", "loose")
	return dir
}

func TestConfigDiscovery(t *testing.T) {
	cases := []struct {
		game string
		dirs []string
		mode filesystem.DiscoveryMode
		disc []string
	}{
		{kbotctx.GameTotalA, []string{"/ta"}, filesystem.DiscoveryGameOrder, []string{"/ta"}},
		{kbotctx.GameTotalA, []string{"/mod", "/ta"}, filesystem.DiscoveryGameOrder, nil},
		{kbotctx.GameTAKingdoms, []string{"/tak"}, filesystem.DiscoveryAllArchives, nil},
		{kbotctx.GameCustom, []string{"/x"}, filesystem.DiscoveryAuto, []string{"/x"}},
		{"", nil, filesystem.DiscoveryAuto, nil},
	}
	for _, c := range cases {
		cfg := Config(c.game, c.dirs...)
		if cfg.Discovery != c.mode {
			t.Errorf("Config(%q, %v).Discovery = %v, want %v", c.game, c.dirs, cfg.Discovery, c.mode)
		}
		if fmt.Sprint(cfg.DiscRoots) != fmt.Sprint(c.disc) {
			t.Errorf("Config(%q, %v).DiscRoots = %v, want %v", c.game, c.dirs, cfg.DiscRoots, c.disc)
		}
		if !cfg.SkipErrors || len(cfg.Extensions) != 4 {
			t.Errorf("Config(%q): SkipErrors=%v Extensions=%v", c.game, cfg.SkipErrors, cfg.Extensions)
		}
	}
}

func TestOpenMountsInGameOrder(t *testing.T) {
	dir := makeInstall(t)
	vfs, err := Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	if got, _ := vfs.ReadFile("units/armcom.fbi"); string(got) != "rev" {
		t.Errorf("units/armcom.fbi = %q, want the rev31.gp3 copy", got)
	}

	rep := Report(vfs)
	if rep.Discovery != "game-order" {
		t.Errorf("Discovery = %q", rep.Discovery)
	}
	var names []string
	for _, m := range rep.Mounted {
		names = append(names, m.Name)
	}
	want := "rev31.gp3 btdata.ccx AFark.ufo zeta.ufo h01.hpi h02.hpi h03.hpi h04.hpi h05.hpi h06.hpi h07.hpi h08.hpi h09.hpi h10.hpi h11.hpi"
	if strings.Join(names, " ") != want {
		t.Errorf("mount order:\n got %s\nwant %s", strings.Join(names, " "), want)
	}
	last := rep.Mounted[len(rep.Mounted)-1]
	if last.Name != "h11.hpi" || last.Note == "" {
		t.Errorf("h11.hpi should carry the disc-root note: %+v", last)
	}
	if rep.Mounted[0].Position != 1 || rep.Mounted[0].Version != "v1" {
		t.Errorf("first mounted = %+v", rep.Mounted[0])
	}

	skipped := map[string]string{}
	for _, s := range rep.Skipped {
		skipped[s.Name] = s.Reason
	}
	if skipped["h00.hpi"] != string(filesystem.SkipNoTrailer) {
		t.Errorf("h00.hpi skip reason = %q, want no-trailer", skipped["h00.hpi"])
	}
	if skipped["kingdoms.hpi"] != string(filesystem.SkipVersion) {
		t.Errorf("kingdoms.hpi skip reason = %q, want version", skipped["kingdoms.hpi"])
	}
	if _, ok := skipped["h11.hpi"]; ok {
		t.Errorf("h11.hpi is mounted by the disc-root scan and must not be listed as skipped")
	}
	if len(rep.Skipped) != 2 {
		t.Errorf("skipped = %+v, want exactly h00.hpi and kingdoms.hpi", rep.Skipped)
	}

	var buf bytes.Buffer
	rep.Print(&buf)
	for _, want := range []string{"Archive discovery: game-order", " 1. rev31.gp3", "15. h11.hpi  - past the ten-*.hpi limit", "Not mounted (2):", "h00.hpi: missing the Cavedog copyright trailer"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("Print output lacks %q:\n%s", want, buf.String())
		}
	}
	if rep.Positions()["btdata.ccx"] != 2 {
		t.Errorf("Positions()[btdata.ccx] = %d", rep.Positions()["btdata.ccx"])
	}
}

func TestOpenLayeredHasNoDiscRoot(t *testing.T) {
	dir := makeInstall(t)
	mod := t.TempDir()
	writeLoose(t, mod, "units/mine.fbi", "mine")
	vfs, err := OpenLayered([]filesystem.Source{
		{Kind: filesystem.SourceContextDir, Path: mod},
		{Kind: filesystem.SourceContextDir, Path: dir},
	}, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	if vfs.Exists("maps/m11.tnt") {
		t.Errorf("h11.hpi is past the ten-*.hpi limit and a layered stack has no disc root")
	}
	if !vfs.Exists("units/mine.fbi") || !vfs.Exists("maps/m10.tnt") {
		t.Errorf("layered mount is missing files")
	}
}

func TestGameOrderFilesKeepsStoredOrder(t *testing.T) {
	dir := makeInstall(t)
	vfs, err := Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()

	feats := FeatureFiles(vfs)
	if strings.Join(feats, ",") != "features/urban/cars2.tdf,features/urban/cars.tdf" {
		t.Errorf("FeatureFiles = %v, want the archive's stored order (cars2 before cars)", feats)
	}
	weapons := WeaponFiles(vfs)
	if strings.Join(weapons, ",") != "weapons/arm.tdf" {
		t.Errorf("WeaponFiles = %v, want the top level only", weapons)
	}
	units := UnitFiles(vfs)
	// armcom.fbi is held by rev31.gp3 and btdata.ccx: listed once, first.
	if len(units) != 3 || units[0] != "units/armcom.fbi" {
		t.Errorf("UnitFiles = %v", units)
	}
}

func TestChainGame(t *testing.T) {
	cfg := &kbotctx.Config{Contexts: map[string]kbotctx.Context{
		"ta":  {Path: "/ta", Game: kbotctx.GameTotalA},
		"mod": {Path: "/mod", Game: kbotctx.GameCustom, Parent: "ta"},
		"raw": {Path: "/raw", Game: kbotctx.GameCustom},
	}}
	if g := ChainGame(cfg, "mod"); g != kbotctx.GameTotalA {
		t.Errorf("ChainGame(mod) = %q, want totala", g)
	}
	if g := ChainGame(cfg, "raw"); g != kbotctx.GameCustom {
		t.Errorf("ChainGame(raw) = %q, want custom", g)
	}
	if g := ChainGame(cfg, "missing"); g != "" {
		t.Errorf("ChainGame(missing) = %q", g)
	}
}
