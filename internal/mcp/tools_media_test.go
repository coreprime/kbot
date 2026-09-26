package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/testutil"
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

// TestPALLookupToolTakesPCXPalette checks that 'palette' may be a PCX, as
// TA: Kingdoms keeps most palettes in PCX files.
func TestPALLookupToolTakesPCXPalette(t *testing.T) {
	root := mediaRoot(t)
	r := mediaResolver(t, root)
	pcxData := make([]byte, 128)
	pcxData[0], pcxData[1], pcxData[2], pcxData[3] = 0x0A, 5, 1, 8
	pcxData[65], pcxData[66] = 1, 1
	pcxData = append(pcxData, 0xC1, 0, 0x0C)
	for i := 0; i < 256; i++ {
		pcxData = append(pcxData, byte(i), 7, 9)
	}
	palPath := writeFile(t, filepath.Join(root, "aramon.pcx"), pcxData)
	table := make([]byte, 8192)
	for i := range table {
		table[i] = 3
	}
	src := writeFile(t, filepath.Join(root, "aramon.shd"), table)
	outPath := filepath.Join(root, "aramon.png")
	var out palImageOutput
	if res := callTool(t, makePALLookupHandler(r), "pal_lookup", map[string]any{
		"path": src, "output": outPath, "cell": 1.0, "palette": palPath,
	}, &out); res.IsError {
		t.Fatal(textOf(res))
	}
	f, err := os.Open(outPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if got := color.RGBAModel.Convert(img.At(10, 5)).(color.RGBA); got != (color.RGBA{3, 7, 9, 255}) {
		t.Errorf("cell colour = %v, want the PCX's entry 3 {3 7 9 255}", got)
	}
}

func TestPCXDescribeReportsGameCompat(t *testing.T) {
	root := mediaRoot(t)
	r := mediaResolver(t, root)
	data := make([]byte, 128)
	data[0], data[1], data[2], data[3] = 0x0A, 3, 1, 8 // version 3
	data[65], data[66] = 1, 1
	data = append(data, 0xC1, 7, 0x0C)
	data = append(data, make([]byte, 768)...)
	src := writeFile(t, filepath.Join(root, "old.pcx"), data)

	var out pcxDescribeOutput
	if res := callTool(t, makePCXDescribeHandler(r), "pcx_describe", map[string]any{"path": src}, &out); res.IsError {
		t.Fatal(textOf(res))
	}
	if out.GameLoads || len(out.GameIssues) == 0 {
		t.Errorf("version 3 file: game_loads=%v issues=%v, want refused", out.GameLoads, out.GameIssues)
	}
}

// testFont builds a 13-row font (baseline 2) whose glyphs (code → width)
// have every pixel set.
func testFont(glyphs map[byte]int) []byte {
	out := []byte{13, 0, 2, 0}
	offsets := make([]byte, 512)
	var data []byte
	for code := 0; code < 256; code++ {
		w, ok := glyphs[byte(code)]
		if !ok {
			continue
		}
		off := 516 + len(data)
		offsets[2*code], offsets[2*code+1] = byte(off), byte(off>>8)
		data = append(data, byte(w))
		data = append(data, bytes.Repeat([]byte{0xFF}, (w*13+7)/8)...)
	}
	return append(append(out, offsets...), data...)
}

func TestFNTToolsFollowTheGame(t *testing.T) {
	root := mediaRoot(t)
	r := mediaResolver(t, root)
	src := writeFile(t, filepath.Join(root, "test.fnt"), testFont(map[byte]int{'A': 10, 0x80: 7}))

	var desc fntDescribeOutput
	if res := callTool(t, makeFNTDescribeHandler(r), "fnt_describe", map[string]any{"path": src}, &desc); res.IsError {
		t.Fatal(textOf(res))
	}
	if desc.Height != 13 || desc.Baseline != 2 || desc.FirstChar != 0 {
		t.Errorf("describe = height %d baseline %d first %d, want 13 2 0", desc.Height, desc.Baseline, desc.FirstChar)
	}

	for _, tc := range []struct {
		text, page string
		width      int
	}{
		{"A A", "", 20}, // no spacing, a missing space adds nothing
		{"€", "", 7},    // Windows-1252 byte 0x80
		{"A\nA", "", 10},
	} {
		var img fntImageOutput
		args := map[string]any{"path": src, "output": filepath.Join(root, "out.png"), "text": tc.text}
		if tc.page != "" {
			args["codepage"] = tc.page
		}
		if res := callTool(t, makeFNTRenderHandler(r), "fnt_render", args, &img); res.IsError {
			t.Fatal(textOf(res))
		}
		if img.Width != tc.width || img.Height != 13 {
			t.Errorf("render %q: %dx%d, want %dx13", tc.text, img.Width, img.Height, tc.width)
		}
	}
	if res := callTool(t, makeFNTRenderHandler(r), "fnt_render",
		map[string]any{"path": src, "output": filepath.Join(root, "x.png"), "text": "A", "codepage": "klingon"}, nil); !res.IsError {
		t.Error("an unknown code page was accepted")
	}
}

func TestZRBToolsDecodeTheHeader(t *testing.T) {
	src := testutil.UnpackedFile(t, "data", "1.zrb")
	r := mediaResolver(t, filepath.Dir(src))

	var info zrbInfoOutput
	if res := callTool(t, makeZRBInfoHandler(r), "zrb_info", map[string]any{"path": src}, &info); res.IsError {
		t.Fatal(textOf(res))
	}
	if len(info.AudioTracks) != 1 {
		t.Fatalf("audio tracks = %+v, want the one present track", info.AudioTracks)
	}
	if tr := info.AudioTracks[0]; tr.SampleRate != 22050 || tr.Channels != 2 {
		t.Errorf("track 0 = %+v, want 22050 Hz stereo", tr)
	}
	if info.Height != 240 || info.DisplayHeight != 480 || info.HeightMode != "interlaced" {
		t.Errorf("height %d display %d mode %q, want 240, 480, interlaced", info.Height, info.DisplayHeight, info.HeightMode)
	}

	out := filepath.Join(t.TempDir(), "x.smk")
	root := mediaRoot(t)
	r2 := mediaResolver(t, root)
	in := writeFile(t, filepath.Join(root, "in.mp4"), []byte("not really"))
	res := callTool(t, makeZRBFromMP4Handler(r2), "zrb_from_mp4", map[string]any{"path": in, "output": filepath.Join(root, filepath.Base(out))}, nil)
	if !res.IsError {
		t.Skip("the installed FFmpeg can write Smacker")
	}
	if !strings.Contains(textOf(res), "no Smacker encoder is available") {
		t.Errorf("zrb_from_mp4 error = %q", textOf(res))
	}
}

// TestZRBFromMP4DescriptionSaysThereIsNoEncoder checks that the tool
// description does not offer a conversion that cannot happen.
func TestZRBFromMP4DescriptionSaysThereIsNoEncoder(t *testing.T) {
	s := server.NewMCPServer("test", "0")
	registerSmackerTools(s, mediaResolver(t, mediaRoot(t)))
	tool := s.GetTool("zrb_from_mp4")
	if tool == nil {
		t.Fatal("zrb_from_mp4 is not registered")
	}
	desc := tool.Tool.Description
	if !strings.HasPrefix(desc, "MP4 to Smacker (.zrb/.smk) is not available: no Smacker encoder exists.") {
		t.Errorf("description = %q, want it to open by saying no Smacker encoder exists", desc)
	}
}
