package gamevfs

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
)

func openInstall(t *testing.T, dir, game string) *ExportCheckEnv {
	t.Helper()
	vfs, err := Open(dir, game)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return &ExportCheckEnv{t: t, check: func(name string, files ...string) ExportCheck {
		return CheckExport(vfs, name, files, "Workspace")
	}}
}

// ExportCheckEnv runs CheckExport against one mounted install.
type ExportCheckEnv struct {
	t     *testing.T
	check func(name string, files ...string) ExportCheck
}

func TestCheckExportUFORanksAboveHPI(t *testing.T) {
	dir := makeInstall(t)
	env := openInstall(t, dir, kbotctx.GameTotalA)

	c := env.check("mymod.ufo", "units/armcom.fbi", "units/mine.fbi", "gamedata/sidedata.tdf")
	if !c.Checked || !c.Mounted {
		t.Fatalf("check = %+v", c)
	}
	// rev31.gp3, btdata.ccx, AFark.ufo come first; zeta.ufo sorts after.
	if c.Position != 4 || strings.Join(c.OutrankedBy, ",") != "rev31.gp3,btdata.ccx,AFark.ufo" {
		t.Errorf("position %d of %d, outranked by %v", c.Position, c.Of, c.OutrankedBy)
	}
	if c.Of != 16 {
		t.Errorf("Of = %d, want 16", c.Of)
	}
	shadow := map[string]string{}
	for _, s := range c.Shadowed {
		shadow[s.Path] = strings.Join(s.By, ",")
	}
	if shadow["units/armcom.fbi"] != "rev31.gp3,btdata.ccx" {
		t.Errorf("units/armcom.fbi shadowed by %q", shadow["units/armcom.fbi"])
	}
	if shadow["gamedata/sidedata.tdf"] != LooseSource {
		t.Errorf("gamedata/sidedata.tdf shadowed by %q, want the loose file", shadow["gamedata/sidedata.tdf"])
	}
	if _, ok := shadow["units/mine.fbi"]; ok {
		t.Errorf("a new file is not shadowed")
	}
	if !containsNote(c, "Ship those files as loose files") || !strings.Contains(c.Hint, "no count limit") {
		t.Errorf("notes = %v", c.Notes)
	}
}

func TestCheckExportHPIPastTheLimit(t *testing.T) {
	dir := makeInstall(t)
	env := openInstall(t, dir, kbotctx.GameTotalA)

	// zz.hpi sorts after h01..h11: the disc-root scan mounts it last.
	c := env.check("zz.hpi", "units/armcom.fbi")
	if !c.Mounted || c.Position != c.Of {
		t.Errorf("zz.hpi: mounted=%v position %d of %d", c.Mounted, c.Position, c.Of)
	}
	if !containsNote(c, "only through the disc-root scan") {
		t.Errorf("notes = %v", c.Notes)
	}

	// a.hpi sorts first among the *.hpi and pushes h10.hpi past the limit.
	c = env.check("a.hpi")
	if c.Displaced != "h10.hpi" {
		t.Errorf("Displaced = %q, want h10.hpi", c.Displaced)
	}
	if c.Position != 5 {
		t.Errorf("a.hpi position = %d, want 5", c.Position)
	}
}

func TestCheckExportHPINotMountedWithoutDiscRoot(t *testing.T) {
	dir := makeInstall(t)
	mod := t.TempDir()
	vfs, err := OpenLayered(sourcesOf(mod, dir), kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	c := CheckExport(vfs, "zz.hpi", nil, "Workspace")
	if c.Mounted || !containsNote(c, "would never mount it") {
		t.Errorf("zz.hpi without a disc root: %+v", c)
	}
}

func TestCheckExportSkipsNonGameOrder(t *testing.T) {
	dir := t.TempDir()
	writeV2Archive(t, filepath.Join(dir, "data.hpi"), file{"units/a.fbi", "x"})
	vfs, err := Open(dir, kbotctx.GameTAKingdoms)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	c := CheckExport(vfs, "mod.hpi", []string{"units/a.fbi"}, "Workspace")
	if c.Checked || len(c.Notes) == 0 {
		t.Errorf("TA: Kingdoms export check = %+v", c)
	}
}

func containsNote(c ExportCheck, sub string) bool {
	for _, n := range c.Notes {
		if strings.Contains(n, sub) {
			return true
		}
	}
	return false
}

// sourcesOf stacks context directories, highest priority first.
func sourcesOf(dirs ...string) []filesystem.Source {
	out := make([]filesystem.Source, 0, len(dirs))
	for _, d := range dirs {
		out = append(out, filesystem.Source{Kind: filesystem.SourceContextDir, Path: d})
	}
	return out
}
