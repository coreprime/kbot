package studio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/kbotctx"
	"github.com/coreprime/kbot/internal/workspace"
)

// exportFixture registers a TA context over taInstall's game directory in
// a private $HOME and creates a workspace on it whose work folder changes
// anims/armhp1.gaf (also in two .ccx archives), units/armcom.fbi (a loose
// file of the install) and adds units/mine.fbi.
func exportFixture(t *testing.T) (*WorkspaceManager, *workspace.Manifest) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv(kbotctx.EnvVar, "")
	install := taInstall(t)
	cfg, err := kbotctx.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Add("ta", kbotctx.Context{Path: install, Game: kbotctx.GameTotalA}, false); err != nil {
		t.Fatal(err)
	}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	man := workspace.New(filepath.Join(t.TempDir(), "mod"), "My Mod", cfg.Contexts["ta"], "ta")
	if err := man.Save(); err != nil {
		t.Fatal(err)
	}
	writeWork(t, man.Dir(), "anims/armhp1.gaf", "mine")
	writeWork(t, man.Dir(), "units/armcom.fbi", "mine")
	writeWork(t, man.Dir(), "units/mine.fbi", "mine")
	return newWorkspaceManager(t.TempDir()), man
}

func hubGet(t *testing.T, m *WorkspaceManager, target string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	m.register(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestParseExportRequest(t *testing.T) {
	req, err := parseExportRequest(url.Values{}, "My Mod", workspace.ExportHPIv1)
	if err != nil || req.Archive != "my-mod.ufo" || req.Preflight {
		t.Errorf("default TA export = %+v, %v; want my-mod.ufo", req, err)
	}
	req, err = parseExportRequest(url.Values{"ext": {".CCX"}, "name": {"A Mod"}, "preflight": {"1"}}, "x", workspace.ExportHPIv1)
	if err != nil || req.Archive != "a-mod.ccx" || !req.Preflight {
		t.Errorf("ccx export = %+v, %v", req, err)
	}
	if _, err := parseExportRequest(url.Values{"ext": {"ufo"}}, "x", workspace.ExportHPIv2); err == nil {
		t.Errorf("TA: Kingdoms exports ship as .hpi only")
	}
	req, _ = parseExportRequest(url.Values{}, "Kingdoms Mod", workspace.ExportHPIv2)
	if req.Archive != "kingdoms-mod.hpi" {
		t.Errorf("TA: Kingdoms default = %q", req.Archive)
	}
}

func TestHubExportPreflight(t *testing.T) {
	m, man := exportFixture(t)
	rec := hubGet(t, m, "/api/hub/export?preflight=1&ext=ufo&dir="+url.QueryEscape(man.Dir()))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got exportPreflight
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Archive != "my-mod.ufo" || !got.Checked || !got.Mounted || got.Files != 3 {
		t.Fatalf("preflight = %+v", got)
	}
	// rev31.gp3, btdata.ccx and ccdata.ccx outrank a .ufo.
	if got.Position != 4 || got.Of != 4 {
		t.Errorf("position %d of %d", got.Position, got.Of)
	}
	shadow := map[string]string{}
	for _, s := range got.Shadowed {
		shadow[s.Path] = strings.Join(s.By, ",")
	}
	if shadow["anims/armhp1.gaf"] != "btdata.ccx,ccdata.ccx" || !strings.Contains(shadow["units/armcom.fbi"], "loose file") {
		t.Errorf("shadowed = %v", shadow)
	}
	if _, ok := shadow["units/mine.fbi"]; ok {
		t.Errorf("units/mine.fbi is new and must not be shadowed")
	}
	if strings.Join(got.Extensions, ",") != "ufo,ccx,hpi" || got.Hint == "" || len(got.Notes) == 0 {
		t.Errorf("extensions %v, hint %q, notes %v", got.Extensions, got.Hint, got.Notes)
	}

	// The same check through the open workspace session.
	sess, err := m.openWorkspace(mustLoadConfig(t), man.Dir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sess.close() })
	srec := httptest.NewRecorder()
	sess.handleExportMod(srec, httptest.NewRequest(http.MethodGet, "/api/studio/export-mod?preflight=1&ext=ccx", nil))
	var viaSession exportPreflight
	if err := json.Unmarshal(srec.Body.Bytes(), &viaSession); err != nil {
		t.Fatalf("%v: %s", err, srec.Body.String())
	}
	// A .ccx sorting after btdata.ccx and ccdata.ccx: "MY-MOD.CCX" > "CCDATA.CCX".
	if viaSession.Archive != "my-mod.ccx" || viaSession.Position != 4 || len(viaSession.Shadowed) != 2 {
		t.Errorf("session preflight = %+v", viaSession)
	}
}

func TestHubExportDownloadsNamedArchive(t *testing.T) {
	m, man := exportFixture(t)
	rec := hubGet(t, m, "/api/hub/export?dir="+url.QueryEscape(man.Dir()))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, `filename="my-mod.ufo"`) {
		t.Errorf("Content-Disposition = %q, want my-mod.ufo", cd)
	}
	assertGameMountable(t, rec.Body.Bytes())

	rec = hubGet(t, m, "/api/hub/export?ext=zip&dir="+url.QueryEscape(man.Dir()))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("ext=zip status = %d, want 400", rec.Code)
	}
}

func TestMapArchiveName(t *testing.T) {
	if got := mapArchiveName("Metal Heck", false); got != "Metal Heck.ufo" {
		t.Errorf("TA map archive = %q", got)
	}
	if got := mapArchiveName("Kingdom", true); got != "Kingdom.hpi" {
		t.Errorf("TA: Kingdoms map archive = %q", got)
	}
}

func mustLoadConfig(t *testing.T) *kbotctx.Config {
	t.Helper()
	cfg, err := kbotctx.Load()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}
