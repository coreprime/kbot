package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"

	"github.com/coreprime/kbot/testutil"
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
