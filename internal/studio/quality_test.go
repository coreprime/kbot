package studio

import (
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
)

// TestQualityCheckerSchemaSlotsGameRules checks the Quality Checker judges
// player slots by the schema the game uses: a 4-start schema after a gap in
// the numbering does not cover numplayers=4, and the checker says the game
// never reads it.
func TestQualityCheckerSchemaSlotsGameRules(t *testing.T) {
	ota := `[GlobalHeader]
{
	missionname=Gap;
	missiondescription=x;
	planet=Green;
	numplayers=2, 4;
	size=4 x 4;
	[Schema 0]
	{
		Type=Network 1;
		[specials]
		{
			[special0] { specialwhat=StartPos1; XPos=100; ZPos=100; }
			[special1] { specialwhat=StartPos2; XPos=400; ZPos=400; }
		}
	}
	[Schema 2]
	{
		Type=Network 1;
		[specials]
		{
			[special0] { specialwhat=StartPos1; XPos=100; ZPos=100; }
			[special1] { specialwhat=StartPos2; XPos=400; ZPos=400; }
			[special2] { specialwhat=StartPos3; XPos=100; ZPos=400; }
			[special3] { specialwhat=StartPos4; XPos=400; ZPos=100; }
		}
	}
}`
	vfs, err := filesystem.NewVirtualFileSystem(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("mount: %v", err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	sess := newSession("test", "test", vfs, t.TempDir())
	req := saveRequest{MapName: "gap", TileW: 16, TileH: 16, OTA: readOTAState([]byte(ota))}
	if req.OTA.Error != "" {
		t.Fatalf("readOTAState: %s", req.OTA.Error)
	}
	m, _, err := sess.buildMap(req)
	if err != nil {
		t.Fatalf("buildMap: %v", err)
	}
	var slots *qualityIssue
	issues := sess.runQualityChecks(m, req, nil)
	for i := range issues {
		if issues[i].Check == "schemaSlots" {
			slots = &issues[i]
		}
	}
	if slots == nil {
		t.Fatalf("no schemaSlots result in %+v", issues)
	}
	if slots.Severity != "warning" || !strings.Contains(slots.Message, "4") || !strings.Contains(slots.Message, "Schema 2") {
		t.Errorf("schemaSlots = %+v; want a warning that 4 players are not covered and Schema 2 is never read", *slots)
	}
}
