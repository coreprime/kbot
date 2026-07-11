package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	"github.com/coreprime/kbot-io/testutil"
)

// TestTNTLintHandler runs the tnt_lint MCP tool against a stock TA
// map and asserts the tile-pool + quality diagnostics come back with
// the expected shape.
func TestTNTLintHandler(t *testing.T) {
	src := testutil.UnpackedFile(t, "maps", "metal heck.tnt")
	mountRoot := t.TempDir()
	srcData, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read src: %v", err)
	}
	srcCopy := filepath.Join(mountRoot, "metal heck.tnt")
	if err := os.WriteFile(srcCopy, srcData, 0o644); err != nil {
		t.Fatalf("write src copy: %v", err)
	}
	// Sibling .ota — copy that too so the quality pass picks it up.
	otaSrc := filepath.Join(filepath.Dir(src), "metal heck.ota")
	if otaData, otaErr := os.ReadFile(otaSrc); otaErr == nil {
		if err := os.WriteFile(filepath.Join(mountRoot, "metal heck.ota"), otaData, 0o644); err != nil {
			t.Fatalf("write ota copy: %v", err)
		}
	}

	guard, err := NewPathGuard([]string{mountRoot})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeTNTLintHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name: "tnt_lint",
			Arguments: map[string]any{
				"path":       srcCopy,
				"similarity": 0.0, // skip slow visual-similarity pass
			},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("unexpected error: %s", textOf(res))
	}
	var out tntLintOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.TileGraphics == 0 {
		t.Errorf("expected non-zero tile graphics")
	}
	if len(out.Quality) == 0 {
		t.Errorf("expected quality diagnostics in the response")
	}
	// dedupTiles should be present in the quality list.
	var foundDedup bool
	for _, q := range out.Quality {
		if q.ID == "dedupTiles" {
			foundDedup = true
			break
		}
	}
	if !foundDedup {
		t.Errorf("expected dedupTiles in quality results, got: %+v", out.Quality)
	}
}

// TestTNTLintHandler_OTAFromArchive packs a TNT + sibling OTA into an
// HPI and asserts the quality pass picks up the .ota even though the
// resolver hands the handler a temp-file copy of the TNT (where the
// "sibling on disk" lookup the handler used to do would find nothing).
func TestTNTLintHandler_OTAFromArchive(t *testing.T) {
	tntSrc := testutil.UnpackedFile(t, "maps", "metal heck.tnt")
	otaSrc := testutil.UnpackedFile(t, "maps", "metal heck.ota")
	tntBytes, err := os.ReadFile(tntSrc)
	if err != nil {
		t.Fatalf("read tnt: %v", err)
	}
	otaBytes, err := os.ReadFile(otaSrc)
	if err != nil {
		t.Fatalf("read ota: %v", err)
	}

	// Pack both into an HPI under a fresh game-data root.
	gameRoot := t.TempDir()
	if resolved, rerr := filepath.EvalSymlinks(gameRoot); rerr == nil {
		gameRoot = resolved
	}
	hpiPath := filepath.Join(gameRoot, "maps.hpi")
	hw, err := hpiv1.CreateWriter(hpiPath)
	if err != nil {
		t.Fatalf("CreateWriter: %v", err)
	}
	hw.SetTrailer(nil)
	if err := hw.AddFileFromBytes("maps/metal heck.tnt", tntBytes); err != nil {
		t.Fatalf("AddFileFromBytes tnt: %v", err)
	}
	if err := hw.AddFileFromBytes("maps/metal heck.ota", otaBytes); err != nil {
		t.Fatalf("AddFileFromBytes ota: %v", err)
	}
	if err := hw.Close(); err != nil {
		t.Fatalf("hpi close: %v", err)
	}

	guard, err := NewPathGuard([]string{gameRoot})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	reg := NewRegistry()
	t.Cleanup(func() { _ = reg.Close() })
	if _, err := reg.Add("totala=" + gameRoot); err != nil {
		t.Fatalf("Registry.Add: %v", err)
	}
	resolver := NewResolver(guard, reg)
	handler := makeTNTLintHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name: "tnt_lint",
			Arguments: map[string]any{
				"path":       "maps/metal heck.tnt",
				"similarity": 0.0,
			},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("unexpected error: %s", textOf(res))
	}
	var out tntLintOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.OTAPath == "" {
		t.Fatalf("expected ota_path to resolve via VFS; got empty.  quality=%+v", out.Quality)
	}
	// When the .ota is loaded, the schema-dependent quality rules must
	// at minimum stop reporting "No schemas to check" — that string is the
	// canary the original bug produced.
	for _, q := range out.Quality {
		switch q.ID {
		case "startsInBounds", "schemaSlots", "metalProximity", "voidIslands":
			if q.Message == "No schemas to check." {
				t.Errorf("rule %q still reports no schemas — .ota was not picked up", q.ID)
			}
		}
	}
}

// TestTNTBuildmapHandler runs the tnt_buildmap MCP tool end-to-end:
// resolves an absolute path through the guard, encodes the PNG and
// asserts the dimensions match the attribute grid.
func TestTNTBuildmapHandler(t *testing.T) {
	src := testutil.UnpackedFile(t, "maps", "metal heck.tnt")
	mountRoot := t.TempDir()
	srcData, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read src: %v", err)
	}
	srcCopy := filepath.Join(mountRoot, "metal heck.tnt")
	if err := os.WriteFile(srcCopy, srcData, 0o644); err != nil {
		t.Fatalf("write src copy: %v", err)
	}
	dst := filepath.Join(mountRoot, "buildmap.png")

	guard, err := NewPathGuard([]string{mountRoot})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeTNTBuildmapHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name: "tnt_buildmap",
			Arguments: map[string]any{
				"path":   srcCopy,
				"output": dst,
			},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("unexpected error: %s", textOf(res))
	}
	var out tntImageOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Width != 262 || out.Height != 262 {
		t.Errorf("expected 262x262 for Metal Heck, got %dx%d", out.Width, out.Height)
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("buildmap not written: %v", err)
	}
}

// TestTNTVoidmapHandler is the parallel of TestTNTBuildmapHandler for
// the void mask.  Asserts the PNG is written at attribute resolution.
func TestTNTVoidmapHandler(t *testing.T) {
	src := testutil.UnpackedFile(t, "maps", "metal heck.tnt")
	mountRoot := t.TempDir()
	srcData, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read src: %v", err)
	}
	srcCopy := filepath.Join(mountRoot, "metal heck.tnt")
	if err := os.WriteFile(srcCopy, srcData, 0o644); err != nil {
		t.Fatalf("write src copy: %v", err)
	}
	dst := filepath.Join(mountRoot, "voidmap.png")

	guard, err := NewPathGuard([]string{mountRoot})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeTNTVoidmapHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name: "tnt_voidmap",
			Arguments: map[string]any{
				"path":   srcCopy,
				"output": dst,
			},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("unexpected error: %s", textOf(res))
	}
	var out tntImageOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Width != 262 || out.Height != 262 {
		t.Errorf("expected 262x262 for Metal Heck, got %dx%d", out.Width, out.Height)
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("voidmap not written: %v", err)
	}
}

// TestTNTOptimizeHandler runs the tnt_optimize tool against a real
// corpus map and asserts that the resulting JSON summary reports a
// non-empty tile graphic count and that the file is rewritten in
// place at the requested output path.
func TestTNTOptimizeHandler(t *testing.T) {
	src := testutil.UnpackedFile(t, "maps", "cc02.tnt")
	mountRoot := t.TempDir()

	// Copy the source TNT into the mount root so the handler's path
	// guard accepts both the input and the output.
	srcData, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read src: %v", err)
	}
	srcCopy := filepath.Join(mountRoot, "cc02.tnt")
	if err := os.WriteFile(srcCopy, srcData, 0o644); err != nil {
		t.Fatalf("write src copy: %v", err)
	}
	dst := filepath.Join(mountRoot, "cc02-opt.tnt")

	guard, err := NewPathGuard([]string{mountRoot})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeTNTOptimizeHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name: "tnt_optimize",
			Arguments: map[string]any{
				"path":       srcCopy,
				"output":     dst,
				"similarity": 0.0, // skip the slow similarity pass in this test
			},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("unexpected error result: %s", textOf(res))
	}

	var out tntOptimizeOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, textOf(res))
	}
	if out.TilesBefore == 0 {
		t.Errorf("TilesBefore = 0, want >0")
	}
	if out.TilesAfter > out.TilesBefore {
		t.Errorf("TilesAfter (%d) > TilesBefore (%d)", out.TilesAfter, out.TilesBefore)
	}
	if out.Output != dst {
		t.Errorf("Output = %q, want %q", out.Output, dst)
	}
	if out.OutputFileSize <= 0 {
		t.Errorf("OutputFileSize = %d, want >0", out.OutputFileSize)
	}

	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("output not written: %v", err)
	}
}

// TestTNTOptimizeHandler_RejectsOutsideMount makes sure path-guard
// failures surface as tool-level errors rather than transport errors.
func TestTNTOptimizeHandler_RejectsOutsideMount(t *testing.T) {
	guard, err := NewPathGuard([]string{t.TempDir()})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeTNTOptimizeHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name: "tnt_optimize",
			Arguments: map[string]any{
				"path":   "/etc/passwd",
				"output": "/tmp/out.tnt",
			},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned transport error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("expected tool-level error, got %#v", res)
	}
}
