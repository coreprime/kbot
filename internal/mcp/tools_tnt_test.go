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
