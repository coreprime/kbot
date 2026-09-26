package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/gaf"
)

// mediaRoot returns a temp folder, with symlinks resolved, that the path
// guard allows.
func mediaRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	return root
}

func mediaResolver(t *testing.T, root string) *Resolver {
	t.Helper()
	guard, err := NewPathGuard([]string{root})
	if err != nil {
		t.Fatal(err)
	}
	return NewResolver(guard, NewRegistry())
}

// callTool runs handler with args and decodes its JSON result into out
// (when non-nil). It returns the result so callers can check IsError.
func callTool(t *testing.T, handler server.ToolHandlerFunc, name string, args map[string]any, out any) *mcplib.CallToolResult {
	t.Helper()
	res, err := handler(context.Background(), mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{Name: name, Arguments: args},
	})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if out != nil && !res.IsError {
		if err := json.Unmarshal([]byte(textOf(res)), out); err != nil {
			t.Fatalf("%s: decode %q: %v", name, textOf(res), err)
		}
	}
	return res
}

func writeFile(t *testing.T, path string, data []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGAFToolsFollowTheGame(t *testing.T) {
	root := mediaRoot(t)
	var buf bytes.Buffer
	seqs := []*gaf.Sequence{
		{Name: "burn", Frames: []*gaf.Frame{
			{Width: 2, Height: 1, TransparencyIndex: 9, Duration: 0, Storage: gaf.StorageRaw, Pixels: []byte{0, 9}},
			{Width: 2, Height: 1, TransparencyIndex: 9, Duration: 2, Storage: gaf.StorageRaw, Pixels: []byte{9, 0}},
		}},
		{Name: "sway", LoopFlags: 1, Frames: []*gaf.Frame{
			{Width: 1, Height: 1, TransparencyIndex: 9, Duration: 3, Pixels: []byte{4}},
		}},
	}
	if err := gaf.WriteGAF(&buf, seqs); err != nil {
		t.Fatal(err)
	}
	src := writeFile(t, filepath.Join(root, "fx.gaf"), buf.Bytes())
	r := mediaResolver(t, root)

	var list gafListOutput
	callTool(t, makeGAFListHandler(r), "gaf_list", map[string]any{"path": src}, &list)
	if len(list.Sequences) != 2 {
		t.Fatalf("sequences = %d", len(list.Sequences))
	}
	if list.Sequences[0].Loops || !list.Sequences[1].Loops {
		t.Errorf("loops = %v/%v, want false/true", list.Sequences[0].Loops, list.Sequences[1].Loops)
	}
	// A zero duration shows for one tick.
	if list.Sequences[0].DurationTicks != 3 {
		t.Errorf("duration = %d ticks, want 3", list.Sequences[0].DurationTicks)
	}

	out := filepath.Join(root, "fx.png")
	var exp gafExportOutput
	res := callTool(t, makeGAFExportHandler(r), "gaf_export", map[string]any{"path": src, "output": out}, &exp)
	if res.IsError {
		t.Fatalf("gaf_export: %s", textOf(res))
	}
	if exp.Format != "png" {
		t.Errorf("default format = %q, want png", exp.Format)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(0, 0).RGBA(); a != 0xffff {
		t.Error("palette index 0 exported transparent; the game draws it black")
	}
	if res := callTool(t, makeGAFExportHandler(r), "gaf_export",
		map[string]any{"path": src, "output": out, "transparency": "sideways"}, nil); !res.IsError {
		t.Error("an unknown transparency mode was accepted")
	}
}

func TestPALLookupToolUsesGameSizes(t *testing.T) {
	root := mediaRoot(t)
	r := mediaResolver(t, root)
	for _, tc := range []struct {
		name    string
		size    int
		wantErr bool
		w, h    int
	}{
		{"palette.alp", 65536, false, 256, 256},
		{"palette.shd", 8192, false, 256, 32},
		{"palette.lht", 1024, true, 0, 0},
	} {
		src := writeFile(t, filepath.Join(root, tc.name), make([]byte, tc.size))
		var out palImageOutput
		res := callTool(t, makePALLookupHandler(r), "pal_lookup", map[string]any{
			"path": src, "output": filepath.Join(root, tc.name+".png"), "cell": 1.0,
		}, &out)
		if res.IsError != tc.wantErr {
			t.Errorf("%s: error = %v (%s), want %v", tc.name, res.IsError, textOf(res), tc.wantErr)
			continue
		}
		if !tc.wantErr && (out.Width != tc.w || out.Height != tc.h) {
			t.Errorf("%s: swatch %dx%d, want %dx%d", tc.name, out.Width, out.Height, tc.w, tc.h)
		}
	}
}
