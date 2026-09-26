package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestBackslashPaths: MCP path arguments may use the game's '\' separator
// on every host, for loose files and for files inside archives alike.
func TestBackslashPaths(t *testing.T) {
	root := makeTestGameData(t)
	writeMCPArchive(t, filepath.Join(root, "rev31.gp3"), false,
		"units/ARMCOM.FBI", "[UNITINFO]{}", "units/CORCOM.FBI", "[UNITINFO]{}")
	r := makeResolver(t, root)

	rf, err := r.ResolveFile(`scripts\ARMCOM.bos`, "")
	if err != nil {
		t.Fatalf(`ResolveFile(scripts\ARMCOM.bos): %v`, err)
	}
	if rf.LocalPath != filepath.Join(root, "scripts", "ARMCOM.bos") || rf.Source != "disk" {
		t.Errorf("loose hit = %+v, want the file on disk", rf)
	}
	_ = rf.Close()

	rf, err = r.ResolveFile(`units\armcom.fbi`, "")
	if err != nil {
		t.Fatalf(`ResolveFile(units\armcom.fbi): %v`, err)
	}
	if rf.VirtualPath != "units/armcom.fbi" || rf.Source != "rev31.gp3" {
		t.Errorf("archive hit = %+v", rf)
	}
	if data, _ := os.ReadFile(rf.LocalPath); string(data) != "[UNITINFO]{}" {
		t.Errorf("archive hit bytes = %q", data)
	}
	_ = rf.Close()

	rd, err := r.ResolveDir(`units\`, "", []string{".fbi"})
	if err != nil {
		t.Fatalf(`ResolveDir(units\): %v`, err)
	}
	if len(rd.Files) != 2 {
		t.Errorf("ResolveDir found %d files, want 2", len(rd.Files))
	}
	_ = rd.Close()

	var stat vfsStatOutput
	if err := json.Unmarshal([]byte(callTool(t, makeVFSStatHandler(r), "vfs_stat", map[string]any{"path": `units\ARMCOM.FBI`})), &stat); err != nil {
		t.Fatal(err)
	}
	if stat.NotFound || stat.VirtualPath != "units/ARMCOM.FBI" || stat.ActiveSource != "rev31.gp3" || len(stat.Layers) != 1 {
		t.Errorf(`vfs_stat(units\ARMCOM.FBI) = %+v`, stat)
	}

	var list vfsListOutput
	if err := json.Unmarshal([]byte(callTool(t, makeVFSListHandler(r), "vfs_list", map[string]any{"path": `units\`})), &list); err != nil {
		t.Fatal(err)
	}
	if list.Path != "units" || list.Count != 2 {
		t.Errorf(`vfs_list(units\) = %+v`, list)
	}
}
