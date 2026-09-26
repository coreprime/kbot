package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
)

// writeMCPArchive writes a version 1 archive with one entry per name/body
// pair. noTrailer leaves off the Cavedog trailer TA 3.1c requires.
func writeMCPArchive(t *testing.T, path string, noTrailer bool, pairs ...string) {
	t.Helper()
	w, err := hpiv1.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	if noTrailer {
		w.AllowNonGameTrailer = true
		w.SetTrailer(nil)
	}
	for i := 0; i+1 < len(pairs); i += 2 {
		if err := w.AddFileFromBytes(pairs[i], []byte(pairs[i+1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func callTool(t *testing.T, h func(context.Context, mcplib.CallToolRequest) (*mcplib.CallToolResult, error), name string, args map[string]any) string {
	t.Helper()
	res, err := h(context.Background(), mcplib.CallToolRequest{Params: mcplib.CallToolParams{Name: name, Arguments: args}})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if res.IsError {
		t.Fatalf("%s returned an error: %s", name, textOf(res))
	}
	return textOf(res)
}

func TestVFSGameDataReportsMountOrder(t *testing.T) {
	root := makeTestGameData(t)
	writeMCPArchive(t, filepath.Join(root, "totala1.hpi"), false, "units/armcom.fbi", "hpi")
	writeMCPArchive(t, filepath.Join(root, "rev31.gp3"), false, "units/armcom.fbi", "gp3")
	writeMCPArchive(t, filepath.Join(root, "bare.hpi"), true, "units/armcom.fbi", "bare")
	if err := os.WriteFile(filepath.Join(root, "junk.ufo"), []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := makeResolver(t, root)

	var out gameDataOutput
	if err := json.Unmarshal([]byte(callTool(t, makeVFSGameDataHandler(r), "vfs_game_data", nil)), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.GameData) != 1 {
		t.Fatalf("game data = %+v", out.GameData)
	}
	gd := out.GameData[0]
	if gd.Discovery != "game-order" || len(gd.MountOrder) != 2 || gd.MountOrder[0].Name != "rev31.gp3" || gd.MountOrder[1].Name != "totala1.hpi" {
		t.Errorf("mount order = %q %+v", gd.Discovery, gd.MountOrder)
	}
	skipped := map[string]string{}
	for _, s := range gd.SkippedArchives {
		skipped[s.Name] = s.Reason
	}
	if skipped["bare.hpi"] != "no-trailer" || skipped["junk.ufo"] == "" {
		t.Errorf("skipped = %+v", gd.SkippedArchives)
	}
}
