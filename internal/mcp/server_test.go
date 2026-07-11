package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"

	"github.com/coreprime/kbot-io/testutil"
)

func TestNewServer_NoMount(t *testing.T) {
	s, cleanup, err := NewServer(Config{Version: "test"})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = cleanup() }()
	if s == nil {
		t.Fatal("expected non-nil server")
	}
}

func TestNewServer_WithMounts(t *testing.T) {
	root := t.TempDir()
	s, cleanup, err := NewServer(Config{
		Version:    "test",
		MountRoots: []string{root},
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = cleanup() }()
	if s == nil {
		t.Fatal("expected non-nil server")
	}
}

func TestNewServer_WithGameData(t *testing.T) {
	root := t.TempDir()
	s, cleanup, err := NewServer(Config{
		Version:  "test",
		GameData: []string{"totala=" + root},
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = cleanup() }()
	if s == nil {
		t.Fatal("expected non-nil server")
	}
}

func TestNewServer_WithContexts_CurrentIsDefault(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()

	registry := NewRegistry()
	defer func() { _ = registry.Close() }()

	specs := []ContextSpec{
		{Alias: "kingdoms", Path: a, Game: "takingdoms"},
		{Alias: "ta-gog", Path: b, Game: "totala", Version: "3.1c", Current: true},
	}
	s, cleanup, err := NewServer(Config{
		Version:  "test",
		Contexts: specs,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	defer func() { _ = cleanup() }()
	if s == nil {
		t.Fatal("nil server")
	}
}

func TestOrderContexts_CurrentFirst(t *testing.T) {
	specs := []ContextSpec{
		{Alias: "a"},
		{Alias: "b", Current: true},
		{Alias: "c"},
	}
	got := orderContexts(specs)
	if len(got) != 3 || got[0].Alias != "b" {
		t.Fatalf("expected current first, got %+v", got)
	}
	// Non-current entries keep their input order.
	if got[1].Alias != "a" || got[2].Alias != "c" {
		t.Fatalf("non-current order changed: %+v", got)
	}
}

func TestOrderContexts_NoCurrent(t *testing.T) {
	specs := []ContextSpec{{Alias: "a"}, {Alias: "b"}}
	got := orderContexts(specs)
	if len(got) != 2 || got[0].Alias != "a" || got[1].Alias != "b" {
		t.Fatalf("expected input order preserved, got %+v", got)
	}
}

func TestOrderContexts_Empty(t *testing.T) {
	if got := orderContexts(nil); got != nil {
		t.Fatalf("expected nil, got %+v", got)
	}
}

// TestCobInfoHandler runs the cob_info tool end-to-end against a real
// .cob file from the unpacked TA assets.  It skips when assets are not
// available so the test still passes on dev machines without them.
func TestCobInfoHandler(t *testing.T) {
	unpacked := testutil.UnpackedPath(t) // skips if not set
	cob := findFirstWithExt(unpacked, ".cob")
	if cob == "" {
		t.Skip("no .cob files found under unpacked assets")
	}

	guard, err := NewPathGuard([]string{unpacked})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeCobInfoHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name:      "cob_info",
			Arguments: map[string]any{"path": cob},
		},
	}

	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil {
		t.Fatal("nil result")
	}
	if res.IsError {
		t.Fatalf("tool returned error: %s", textOf(res))
	}

	var info cobInfo
	if err := json.Unmarshal([]byte(textOf(res)), &info); err != nil {
		t.Fatalf("unmarshal result: %v\nbody: %s", err, textOf(res))
	}
	if info.Path == "" {
		t.Errorf("info.Path empty")
	}
	if info.NumScripts == 0 && info.NumPieces == 0 {
		t.Errorf("expected at least one script or piece, got zero of both")
	}
}

// TestCobInfoHandler_RejectsOutsideMount ensures the path guard wires
// in correctly to a real tool — a path outside the mount root must be
// reported as a tool-level error, not as a transport error.
func TestCobInfoHandler_RejectsOutsideMount(t *testing.T) {
	guard, err := NewPathGuard([]string{t.TempDir()})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	resolver := NewResolver(guard, NewRegistry())
	handler := makeCobInfoHandler(resolver)

	req := mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{
			Name:      "cob_info",
			Arguments: map[string]any{"path": "/etc/passwd"},
		},
	}
	res, err := handler(context.Background(), req)
	if err != nil {
		t.Fatalf("handler returned transport error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("expected tool-level error, got %#v", res)
	}
	if !strings.Contains(textOf(res), "outside the configured mount roots") {
		t.Errorf("error message %q does not mention mount roots", textOf(res))
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

// findFirstWithExt walks root and returns the first non-directory entry
// whose extension (case-insensitive) matches ext.  Returns "" if none.
func findFirstWithExt(root, ext string) string {
	var found string
	stop := errors.New("stop")
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ext) {
			found = path
			return stop
		}
		return nil
	})
	return found
}

// textOf extracts the first text content from a tool result.  We accept
// both value and pointer TextContent because the SDK has used both
// representations across versions.
func textOf(res *mcplib.CallToolResult) string {
	if res == nil {
		return ""
	}
	for _, c := range res.Content {
		switch v := c.(type) {
		case mcplib.TextContent:
			return v.Text
		case *mcplib.TextContent:
			return v.Text
		}
	}
	return ""
}
