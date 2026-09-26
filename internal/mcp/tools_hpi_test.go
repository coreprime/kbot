package mcp

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestHPIToolsReportGameMount(t *testing.T) {
	root := makeTestGameData(t)
	good := filepath.Join(root, "good.ufo")
	writeMCPArchive(t, good, false, "units/a.fbi", "a")
	bare := filepath.Join(root, "bare.hpi")
	writeMCPArchive(t, bare, true, "units/a.fbi", "a")
	r := makeResolver(t, root)

	var info hpiInfoOutput
	if err := json.Unmarshal([]byte(callToolText(t, makeHPIInfoHandler(r), "hpi_info", map[string]any{"path": good})), &info); err != nil {
		t.Fatal(err)
	}
	if !info.GameMount.Mountable || info.GameMount.Line != "TA 3.1c would mount: yes" || info.GameMount.TrailerYear != "1997" || !info.GameMount.Encrypted {
		t.Errorf("good.ufo game_mount = %+v", info.GameMount)
	}
	info = hpiInfoOutput{}
	if err := json.Unmarshal([]byte(callToolText(t, makeHPIInfoHandler(r), "hpi_info", map[string]any{"path": bare})), &info); err != nil {
		t.Fatal(err)
	}
	if info.GameMount.Mountable || !strings.Contains(info.GameMount.Reason, "trailer") || info.GameMount.TrailerValid {
		t.Errorf("bare.hpi game_mount = %+v", info.GameMount)
	}

	var list hpiListOutput
	if err := json.Unmarshal([]byte(callToolText(t, makeHPIListHandler(r), "hpi_list", map[string]any{"path": bare})), &list); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(list.GameMount, "TA 3.1c would mount: no, ") || list.Total != 1 {
		t.Errorf("hpi_list = %+v", list)
	}
}
