package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot-io/testutil"
)

// callTNTTool runs a tnt tool handler over files under root and decodes its
// JSON result into out.
func callTNTTool(t *testing.T, root string, makeHandler func(*Resolver) server.ToolHandlerFunc, name string, args map[string]any, out any) {
	t.Helper()
	guard, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	res, err := makeHandler(NewResolver(guard, NewRegistry()))(context.Background(),
		mcplib.CallToolRequest{Params: mcplib.CallToolParams{Name: name, Arguments: args}})
	if err != nil || res == nil || res.IsError {
		t.Fatalf("%s: %v %s", name, err, textOf(res))
	}
	if err := json.Unmarshal([]byte(textOf(res)), out); err != nil {
		t.Fatalf("%s: decode: %v\n%s", name, err, textOf(res))
	}
}

// TestTNTDescribeFormatAndMinimapFlags checks tnt_describe names the game
// that reads a map and reports the minimap flags word.
func TestTNTDescribeFormatAndMinimapFlags(t *testing.T) {
	root := t.TempDir()
	for _, c := range []struct{ src, name, format string }{
		{testutil.UnpackedFile(t, "maps", "metal heck.tnt"), "ta.tnt", "ta"},
		{testutil.TAKUnpackedFile(t, "maps", "abnar's terrace.tnt"), "tak.tnt", "kingdoms"},
	} {
		data, err := os.ReadFile(c.src)
		if err != nil {
			t.Fatal(err)
		}
		dst := filepath.Join(root, c.name)
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			t.Fatal(err)
		}
		var out tntDescribeOutput
		callTNTTool(t, root, makeTNTDescribeHandler, "tnt_describe", map[string]any{"path": dst}, &out)
		if out.Format != c.format {
			t.Errorf("%s: format = %q, want %q", c.name, out.Format, c.format)
		}
		if c.format == "ta" && out.MinimapFlags&tnt.MinimapPresent == 0 {
			t.Errorf("%s: minimap flags = %d, want bit 0 set", c.name, out.MinimapFlags)
		}
	}
}

// TestTNTOptimizeKeepsBadTileIndices checks tnt_optimize rewrites a map
// holding a tile index past its tile set, keeping the index and warning
// about it, instead of failing.
func TestTNTOptimizeKeepsBadTileIndices(t *testing.T) {
	m := &tnt.Map{
		Header: tnt.Header{IDVersion: tnt.VersionTA},
		TileW:  2, TileH: 2, AttrW: 4, AttrH: 4,
		TileMap:  []uint16{0, 1, 7, 0},
		TileAttr: make([]tnt.TileAttr, 16),
		Tiles:    [][]byte{make([]byte, tnt.TileGfxSize), make([]byte, tnt.TileGfxSize)},
	}
	for i := range m.TileAttr {
		m.TileAttr[i].Feature = tnt.FeatureNone
	}
	var buf bytes.Buffer
	if err := m.SaveWithOptions(&buf, nil, tnt.SaveOptions{AllowUnresolvedIndices: true}); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	src, dst := filepath.Join(root, "bad.tnt"), filepath.Join(root, "out.tnt")
	if err := os.WriteFile(src, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	var out tntOptimizeOutput
	callTNTTool(t, root, makeTNTOptimizeHandler, "tnt_optimize", map[string]any{"path": src, "output": dst, "similarity": 0.0}, &out)
	if out.TilesAfter != 1 {
		t.Errorf("tiles after = %d, want the duplicate merged to 1", out.TilesAfter)
	}
	if len(out.Warnings) == 0 {
		t.Errorf("no warning about the kept tile index")
	}
	data, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	got, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil || got.TileMap[2] != 7 {
		t.Errorf("optimized map: %v, cell 2 = %v; want index 7 kept", err, got)
	}
}
