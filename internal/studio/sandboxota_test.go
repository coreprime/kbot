package studio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

const sandboxTestOTA = `
[GlobalHeader]
	{
	missionname=Test;
	sealevel=40;
	[Schema 0]
		{
		Type=Easy;
		SurfaceMetal=1;
		[specials] { [special0] { specialwhat=StartPos1; XPos=1; ZPos=1; } }
		}
	[Schema 1]
		{
		Type=Network 1;
		SurfaceMetal=3;
		[specials]
			{
			[special0] { specialwhat=StartPos2; XPos=200; ZPos=20; }
			[special1] { specialwhat=startpos1; XPos=100; ZPos=10; }
			}
		}
	[Schema 2]
		{
		Type=Network 2;
		SurfaceMetal=300;
		[specials]
			{
			[special0] { specialwhat=StartPos; XPos=11; ZPos=12; }
			[special1] { specialwhat=StartPos; XPos=21; ZPos=22; }
			[special2] { specialwhat=StartPos0; XPos=31; ZPos=32; }
			[special3] { specialwhat=StartPos4; XPos=41; ZPos=42; }
			}
		}
	[Schema 4]
		{
		Type=Network 3;
		SurfaceMetal=99;
		[specials] { [special0] { specialwhat=StartPos1; XPos=5; ZPos=5; } [special1] { specialwhat=StartPos2; XPos=6; ZPos=6; } }
		}
	}
`

// TestReadSandboxOTASchemaChoice: the sandbox uses the schema a skirmish of
// its player count picks — Network types over the contiguous Schema 0..N,
// exactly that many starts preferred, else the most — never simply the first
// schema in the file (here an Easy campaign schema).
func TestReadSandboxOTASchemaChoice(t *testing.T) {
	ota := readSandboxOTA([]byte(sandboxTestOTA), false, 2)
	if ota == nil || ota.Schema != "Schema 1 (Network 1)" {
		t.Fatalf("2 players: schema %+v, want Schema 1 (Network 1)", ota)
	}
	if ota.SurfaceMetal != 3 {
		t.Errorf("SurfaceMetal %d, want 3", ota.SurfaceMetal)
	}
	if ota.SeaLevel != 0 {
		t.Errorf("TA sea level %d from the OTA, want 0 (TA reads it from the TNT header)", ota.SeaLevel)
	}
	// 3 players: no schema has exactly three starts, so the one with the
	// most wins.
	if three := readSandboxOTA([]byte(sandboxTestOTA), false, 3); three.Schema != "Schema 2 (Network 2)" {
		t.Errorf("3 players: %q, want Schema 2 (Network 2)", three.Schema)
	}
	// Start positions keep [specials] order and the game's numbering:
	// StartPos1 is slot 0 whatever its place in the list.
	if len(ota.Starts) != 2 || ota.Starts[0].Number != 2 || ota.Starts[0].Slot != 1 ||
		ota.Starts[1].Number != 1 || ota.Starts[1].Slot != 0 || ota.Starts[1].X != 100 {
		t.Fatalf("starts = %+v", ota.Starts)
	}

	// 4 players: Schema 2 has exactly four starts. ([Schema 4] is past the
	// gap after Schema 2, so the game never reads it.)
	four := readSandboxOTA([]byte(sandboxTestOTA), false, 4)
	if four.Schema != "Schema 2 (Network 2)" {
		t.Fatalf("4 players: %q, want Schema 2 (Network 2)", four.Schema)
	}
	// SurfaceMetal is kept as the byte the game stores: 300 is 44.
	if four.SurfaceMetal != 44 {
		t.Errorf("SurfaceMetal %d, want 44", four.SurfaceMetal)
	}
	var numbers, slots []int
	for _, s := range four.Starts {
		numbers = append(numbers, s.Number)
		slots = append(slots, s.Slot)
	}
	// Unnumbered entries take the next implicit number; StartPos0 is slot 0.
	if want := []int{1, 2, 0, 4}; !equalInts(numbers, want) {
		t.Errorf("numbers %v, want %v", numbers, want)
	}
	if want := []int{0, 1, 0, 3}; !equalInts(slots, want) {
		t.Errorf("slots %v, want %v", slots, want)
	}
}

// TestReadSandboxOTAInventsNothing: a campaign-only map uses its medium
// schema, and a schema without starts gives none.
func TestReadSandboxOTAInventsNothing(t *testing.T) {
	ota := readSandboxOTA([]byte(`[GlobalHeader] {
		[Schema 0] { Type=Easy; SurfaceMetal=2; }
		[Schema 1] { Type=Medium; SurfaceMetal=5; [specials] { [special0] { specialwhat=Crate; XPos=1; ZPos=1; } } }
	}`), false, 2)
	if ota == nil || ota.Schema != "Schema 1 (Medium)" || ota.SurfaceMetal != 5 || len(ota.Starts) != 0 {
		t.Fatalf("campaign map: %+v, want Schema 1 (Medium), metal 5, no starts", ota)
	}
	if readSandboxOTA([]byte(`[NotAMap] { a=1; }`), false, 2) != nil {
		t.Fatalf("text with no [GlobalHeader] read as a map")
	}
}

func TestReadSandboxOTATAK(t *testing.T) {
	ota := readSandboxOTA([]byte(`[GlobalHeader] { sealevel=58;
		[Map Data] { [specials] {
			[special0] { specialwhat=StartPos2; XPos=215; ZPos=38; }
			[special1] { specialwhat=StartPos1; XPos=37; ZPos=190; }
		} } }`), true, 2)
	if ota == nil || ota.SeaLevel != 58 || ota.SurfaceMetal != 0 || len(ota.Starts) != 2 ||
		ota.Starts[1].Slot != 0 || ota.Starts[1].X != 37 {
		t.Fatalf("TA:K OTA = %+v", ota)
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sandboxMapFor(t *testing.T, sess *Session, mapPath string) sandboxMapJSON {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/studio/sandbox-map?path="+url.QueryEscape(mapPath), nil)
	rr := httptest.NewRecorder()
	sess.handleSandboxMap(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("%s: status %d: %s", mapPath, rr.Code, rr.Body.String())
	}
	var out sandboxMapJSON
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestSandboxMapSurfaceMetal: the sandbox map carries the schema's
// SurfaceMetal, and the hosted match's terrain floods every cell with it, as
// the browser sim does from the JSON.
func TestSandboxMapSurfaceMetal(t *testing.T) {
	sess := mountVFSForTest(t)
	heck := sandboxMapFor(t, sess, "maps/metal heck.tnt")
	if heck.SurfaceMetal != 255 {
		t.Fatalf("Metal Heck surfaceMetal %d, want 255", heck.SurfaceMetal)
	}
	terr := sess.buildHostTerrain("maps/metal heck.tnt")
	if terr == nil || len(terr.Metal) != terr.W*terr.H || terr.Metal[0] != 255 || terr.Metal[len(terr.Metal)-1] != 255 {
		t.Fatalf("host terrain metal not flooded with 255")
	}
	comet := sandboxMapFor(t, sess, "maps/comet catcher.tnt")
	if comet.SurfaceMetal != 3 {
		t.Fatalf("Comet Catcher surfaceMetal %d, want 3", comet.SurfaceMetal)
	}
	if got := surfaceMetalGrid(2, 2, 0); got != nil {
		t.Fatalf("SurfaceMetal 0 floods %v, want no grid", got)
	}
}

// TestSandboxMapStartSlots: Comet Catcher lists StartPos4 first; player 1's
// start is still StartPos1 (slot 0) at (512, 6864).
func TestSandboxMapStartSlots(t *testing.T) {
	sess := mountVFSForTest(t)
	comet := sandboxMapFor(t, sess, "maps/comet catcher.tnt")
	if len(comet.StartPositions) != 10 {
		t.Fatalf("Comet Catcher: %d starts, want 10", len(comet.StartPositions))
	}
	if first := comet.StartPositions[0]; first.Number != 4 || first.Slot != 3 {
		t.Fatalf("first listed start = %+v, want StartPos4 (slot 3)", first)
	}
	var p1 *sandboxStartPos
	for i := range comet.StartPositions {
		if comet.StartPositions[i].Slot == 0 {
			p1 = &comet.StartPositions[i]
			break
		}
	}
	if p1 == nil || p1.Number != 1 || p1.X != 512 || p1.Z != 6864 {
		t.Fatalf("player 1 start = %+v, want StartPos1 at (512, 6864)", p1)
	}
	if comet.Schema != "Schema 0 (Network 1)" {
		t.Errorf("schema %q", comet.Schema)
	}
}
