package studio

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/testutil"
)

// editorOTA is a map .ota with everything the editor does not model: CRLF
// line ends, a comment, fractions, victory and trigger keys, [units],
// [features], a non-start special, StartPos0 and an unnumbered start, a
// schema the game never reads and a key after the schemas.
var editorOTA = strings.Join([]string{
	"[GlobalHeader]",
	"\t{",
	"\tmissionname=Rocky Road; // shown in the lobby",
	"\tmissiondescription=Two ridges.;",
	"\tplanet=Green Planet;",
	"\tglamoursound=;",
	"\ttidalstrength=12.5;",
	"\tsolarstrength=20;",
	"\tkillmul=0.5;",
	"\ttimemul=1.25;",
	"\tmaxunits=250;",
	"\twaterdamage=100;",
	"\tsealevel=40;",
	"\tuseonlyunits=rocky.tdf;",
	"\tnumplayers=2-4;",
	"\tsize=8 x 8;",
	"\tDestroyAllUnits=1;",
	"\tSCHEMACOUNT=3;",
	"\t[Schema 0]",
	"\t\t{",
	"\t\tType=Network 1;",
	"\t\taiprofile=DEFAULT;",
	"\t\tSurfaceMetal=3;",
	"\t\tMeteorDensity=0.25;",
	"\t\t[specials]",
	"\t\t\t{",
	"\t\t\t[special0] { specialwhat=StartPos2; XPos=300; ZPos=310; }",
	"\t\t\t[special1] { specialwhat=MetalSpot; XPos=5; ZPos=6; }",
	"\t\t\t[special2] { specialwhat=StartPos0; XPos=100; ZPos=110; }",
	"\t\t\t[special3] { specialwhat=startpos; XPos=200; ZPos=210; Ident=CMD; }",
	"\t\t\t}",
	"\t\t[units]",
	"\t\t\t{",
	"\t\t\t[unit0] { Unitname=ARMFAV; XPos=64; ZPos=64; Player=2; }",
	"\t\t\t}",
	"\t\t[features]",
	"\t\t\t{",
	"\t\t\t[feature0] { Featurename=Rock1; XPos=0; ZPos=0; }",
	"\t\t\t}",
	"\t\t}",
	"\t[Schema 1]",
	"\t\t{",
	"\t\tType=Network 2;",
	"\t\tSurfaceMetal=255;",
	"\t\t[specials]",
	"\t\t\t{",
	"\t\t\t[special0] { specialwhat=StartPos1; XPos=1; ZPos=2; }",
	"\t\t\t}",
	"\t\t}",
	"\t[Schema 5]",
	"\t\t{",
	"\t\tType=Network 3;",
	"\t\t}",
	"\tAllUnitsKilled=1;",
	"\t}",
	"",
}, "\r\n")

// loadEditorState reads an .ota into the editor state and fails the test
// when it cannot.
func loadEditorState(t *testing.T, src string) *otaState {
	t.Helper()
	st := readOTAState([]byte(src))
	if st.Error != "" {
		t.Fatalf("readOTAState: %s", st.Error)
	}
	return st
}

// TestReadOTAStateGameView checks the editor reads the .ota the way the
// game does: only the schemas it finds, start positions numbered its way
// (StartPos0 and unnumbered entries kept) in slot order, fractions kept and
// numplayers kept as text.
func TestReadOTAStateGameView(t *testing.T) {
	st := loadEditorState(t, editorOTA)
	if len(st.Schemas) != 2 {
		t.Fatalf("schemas = %d, want 2 (Schema 5 follows a gap)", len(st.Schemas))
	}
	if len(st.UnreachableSchemas) != 1 || st.UnreachableSchemas[0] != "Schema 5" {
		t.Errorf("unreachable schemas = %v, want [Schema 5]", st.UnreachableSchemas)
	}
	if st.TidalStrength != 12.5 || st.Killmul != 0.5 || st.Timemul != 1.25 {
		t.Errorf("fractions = %v %v %v, want 12.5 0.5 1.25", st.TidalStrength, st.Killmul, st.Timemul)
	}
	if st.NumPlayers != "2-4" {
		t.Errorf("numplayers = %q, want the text 2-4", st.NumPlayers)
	}
	if st.Schemas[0].MeteorDensity != 0.25 {
		t.Errorf("meteor density = %v, want 0.25", st.Schemas[0].MeteorDensity)
	}
	type row struct{ number, special, x int }
	var got []row
	for _, sp := range st.Schemas[0].StartPos {
		got = append(got, row{sp.Number, *sp.Special, sp.X})
	}
	want := []row{{0, 2, 100}, {1, 3, 200}, {2, 0, 300}}
	if len(got) != len(want) {
		t.Fatalf("start positions = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("start %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if s := st.Schemas[1].Source; s == nil || *s != 1 {
		t.Errorf("schema 1 source = %v, want 1", s)
	}
}

// TestEditOTAUnchangedIsIdentical checks saving an untouched map writes
// its .ota back byte for byte.
func TestEditOTAUnchangedIsIdentical(t *testing.T) {
	st := loadEditorState(t, editorOTA)
	out, err := editOTA([]byte(editorOTA), st)
	if err != nil {
		t.Fatalf("editOTA: %v", err)
	}
	if string(out) != editorOTA {
		t.Fatalf("unchanged state rewrote the file:\n%s", out)
	}
}

// TestEditOTAChangesOnlyTouchedValues checks value edits, a moved start
// and added schema and start positions change only those parts of the
// text.
func TestEditOTAChangesOnlyTouchedValues(t *testing.T) {
	st := loadEditorState(t, editorOTA)
	st.MissionName = "Rocky Road II"
	st.TidalStrength = 18.75
	st.SeaLevel = 55
	st.Schemas[0].SurfaceMetal = 5
	st.Schemas[0].StartPos[2].X = 320 // StartPos2
	st.Schemas[1].StartPos = append(st.Schemas[1].StartPos, saveStartPos{Number: 2, X: 900, Z: 910})
	st.Schemas = append(st.Schemas, otaSchema{Type: "Network 3", AIProfile: "DEFAULT", SurfaceMetal: 7,
		StartPos: []saveStartPos{{Number: 1, X: 10, Z: 20}}})

	out, err := editOTA([]byte(editorOTA), st)
	if err != nil {
		t.Fatalf("editOTA: %v", err)
	}
	text := string(out)
	for _, want := range []string{
		"\tmissionname=Rocky Road II; // shown in the lobby\r\n",
		"\ttidalstrength=18.75;\r\n",
		"\tsealevel=55;\r\n",
		"\t\tSurfaceMetal=5;\r\n",
		"[special0] { specialwhat=StartPos2; XPos=320; ZPos=310; }",
		"\tkillmul=0.5;\r\n", "\ttimemul=1.25;\r\n", "\tmaxunits=250;\r\n", "\twaterdamage=100;\r\n",
		"\tDestroyAllUnits=1;\r\n", "\tAllUnitsKilled=1;\r\n", "\tnumplayers=2-4;\r\n",
		"[unit0] { Unitname=ARMFAV; XPos=64; ZPos=64; Player=2; }",
		"[feature0] { Featurename=Rock1; XPos=0; ZPos=0; }",
		"[special3] { specialwhat=startpos; XPos=200; ZPos=210; Ident=CMD; }",
		"\t\tMeteorDensity=0.25;\r\n",
		"\tSCHEMACOUNT=4;\r\n",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q", want)
		}
	}
	// Only the changed lines differ, plus the added sections.
	if changed := diffLines(editorOTA, text); changed != 6 {
		t.Errorf("%d source lines changed, want 6 (missionname, tidal, sealevel, SurfaceMetal, special0, SCHEMACOUNT):\n%s", changed, text)
	}
	m, err := ta.ReadMap(out)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	game := m.Header.GameSchemas()
	if len(game) != 3 {
		t.Fatalf("game schemas = %d, want 3: the new schema must not follow a gap", len(game))
	}
	if ps := game[1].StartPositions(); len(ps) != 2 || ps[1].X != 900 {
		t.Errorf("schema 1 starts = %+v, want the added StartPos2 at 900", ps)
	}
	if ps := game[2].StartPositions(); len(ps) != 1 || ps[0].Number != 1 || game[2].Type != "Network 3" {
		t.Errorf("new schema = %+v %+v", game[2], ps)
	}
}

// diffLines counts the source lines that no longer appear in the output.
func diffLines(src, out string) int {
	have := map[string]int{}
	for _, l := range strings.Split(out, "\r\n") {
		have[l]++
	}
	n := 0
	for _, l := range strings.Split(src, "\r\n") {
		if have[l] > 0 {
			have[l]--
			continue
		}
		n++
	}
	return n
}

// TestEditOTARemovals checks removing a start position and a schema keeps
// everything else the file had and renumbers the later schemas so the game
// still finds them.
func TestEditOTARemovals(t *testing.T) {
	st := loadEditorState(t, editorOTA)
	// Remove StartPos0 (slot order puts it first) and renumber like the
	// editor does; remove Schema 0 altogether in a second edit.
	st.Schemas[0].StartPos = st.Schemas[0].StartPos[1:]
	for i := range st.Schemas[0].StartPos {
		st.Schemas[0].StartPos[i].Number = i + 1
	}
	out, err := editOTA([]byte(editorOTA), st)
	if err != nil {
		t.Fatalf("editOTA (start removed): %v", err)
	}
	m, err := ta.ReadMap(out)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	s0 := m.Header.GameSchemas()[0]
	if n := len(s0.Specials.Items); n != 3 {
		t.Errorf("specials = %d, want 3 (MetalSpot kept, StartPos0 removed)", n)
	}
	var nums []int
	for _, p := range s0.StartPositions() {
		nums = append(nums, p.Number)
	}
	if len(nums) != 2 || nums[0] != 2 || nums[1] != 1 {
		t.Errorf("start numbers in file order = %v, want [2 1]", nums)
	}
	if s0.Units == nil || len(s0.Units.Items) != 1 || s0.Features == nil || s0.GameFeatures() == nil {
		t.Errorf("[units] or [features] lost: %+v %+v", s0.Units, s0.Features)
	}
	h := &m.Header
	if h.EffectiveKillMul() != 0.5 || h.EffectiveTimeMul() != 1.25 || h.EffectiveMaxUnits() != 250 || h.WaterDamage != 100 {
		t.Errorf("header values lost: killmul %v timemul %v maxunits %v waterdamage %v",
			h.EffectiveKillMul(), h.EffectiveTimeMul(), h.EffectiveMaxUnits(), h.WaterDamage)
	}
	for _, k := range []string{"DestroyAllUnits", "AllUnitsKilled", "useonlyunits"} {
		if !strings.Contains(strings.ToLower(string(out)), strings.ToLower(k)) {
			t.Errorf("%s lost", k)
		}
	}

	st = loadEditorState(t, editorOTA)
	st.Schemas = st.Schemas[1:]
	out, err = editOTA([]byte(editorOTA), st)
	if err != nil {
		t.Fatalf("editOTA (schema removed): %v", err)
	}
	m, err = ta.ReadMap(out)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	game := m.Header.GameSchemas()
	if len(game) != 1 || game[0].Type != "Network 2" {
		t.Fatalf("game schemas = %d (%+v), want the former Schema 1 as Schema 0", len(game), game)
	}
	if un := m.Header.UnreachableSchemas(); len(un) != 1 || un[0] != "Schema 5" {
		t.Errorf("unreachable = %v, want Schema 5 left as it was", un)
	}
	if !strings.Contains(string(out), "SCHEMACOUNT=2;") {
		t.Errorf("SCHEMACOUNT not kept in step:\n%s", out)
	}
}

// TestEditOTAUnnumberedStarts checks removing an unnumbered StartPos entry
// keeps the others' numbers, which the game gives by their order.
func TestEditOTAUnnumberedStarts(t *testing.T) {
	src := "[GlobalHeader]\n{\n[Schema 0]\n{\nType=Network 1;\n[specials]\n{\n" +
		"[special0] { specialwhat=StartPos; XPos=1; ZPos=1; }\n" +
		"[special1] { specialwhat=StartPos; XPos=2; ZPos=2; }\n" +
		"[special2] { specialwhat=StartPos; XPos=3; ZPos=3; }\n}\n}\n}\n"
	st := loadEditorState(t, src)
	// Remove the last: the other two keep their text.
	last := *st
	last.Schemas = []otaSchema{st.Schemas[0]}
	last.Schemas[0].StartPos = st.Schemas[0].StartPos[:2]
	out, err := editOTA([]byte(src), &last)
	if err != nil {
		t.Fatalf("editOTA: %v", err)
	}
	if strings.Count(string(out), "specialwhat=StartPos;") != 2 {
		t.Errorf("remaining unnumbered entries rewritten:\n%s", out)
	}
	// Remove the first: the editor renumbers the rest 1, 2, and the file
	// must still read them so.
	st = loadEditorState(t, src)
	st.Schemas[0].StartPos = st.Schemas[0].StartPos[1:]
	for i := range st.Schemas[0].StartPos {
		st.Schemas[0].StartPos[i].Number = i + 1
	}
	if _, err := editOTA([]byte(src), st); err != nil {
		t.Fatalf("editOTA: %v", err)
	}
}

// TestEditOTAValidatesText checks editor text the game would read back
// differently is refused with an error the user can act on.
func TestEditOTAValidatesText(t *testing.T) {
	for _, bad := range []string{"See http://tauniverse.com", "Two; three", "a /* b"} {
		st := loadEditorState(t, editorOTA)
		st.MissionDescription = bad
		_, err := editOTA([]byte(editorOTA), st)
		var editErr *otaEditError
		if !errors.As(err, &editErr) || editErr.field != "missiondescription" {
			t.Errorf("%q: err = %v, want an otaEditError for missiondescription", bad, err)
		}
		if saveErrorStatus(err) != http.StatusBadRequest {
			t.Errorf("%q: status %d, want 400", bad, saveErrorStatus(err))
		}
	}
	st := loadEditorState(t, editorOTA)
	st.Schemas[1].Type = "Network 2 // two"
	if _, err := editOTA([]byte(editorOTA), st); err == nil {
		t.Errorf("schema type with a comment was accepted")
	}
}

// schemaOTA builds an .ota whose [GlobalHeader] holds one schema section
// per name, in order, each with its name as its Type and one start
// position.
func schemaOTA(names ...string) string {
	var b strings.Builder
	b.WriteString("[GlobalHeader]\n{\nmissionname=Gaps;\n")
	for _, n := range names {
		fmt.Fprintf(&b, "[%s]\n{\nType=%s;\n[specials]\n{\n[special0] { specialwhat=StartPos1; XPos=16; ZPos=16; }\n}\n}\n", n, n)
	}
	b.WriteString("}\n")
	return b.String()
}

// TestEditOTARefusesSchemasMadeReadable checks a save that would number the
// schemas so that the game reads a section it skips now is refused with an
// error naming that section (a 400 the user sees, with nothing written),
// instead of losing the save's other edits; saves that leave the skipped
// sections skipped go through.
func TestEditOTARefusesSchemasMadeReadable(t *testing.T) {
	added := otaSchema{Type: "Network 2", StartPos: []saveStartPos{{Number: 1, X: 32, Z: 32}}}
	cases := []struct {
		name string
		src  string
		edit func(st *otaState)
		want string // the section named in the error; "" for a save that goes through
	}{
		{"add fills a one-number gap", schemaOTA("Schema 0", "Schema 2"),
			func(st *otaState) { st.Schemas = append(st.Schemas, added) }, "[Schema 2]"},
		{"add to a file with no Schema 0", schemaOTA("Schema 1"),
			func(st *otaState) { st.Schemas = append(st.Schemas, added) }, "[Schema 1]"},
		{"remove puts a repeated number first", schemaOTA("Schema 0", "Schema 1", "schema 1", "Schema 2"),
			func(st *otaState) { st.Schemas = st.Schemas[1:] }, "[schema 1]"},
		{"add before a wider gap", schemaOTA("Schema 0", "Schema 3"),
			func(st *otaState) { st.Schemas = append(st.Schemas, added) }, ""},
		{"remove before a gap", schemaOTA("Schema 0", "Schema 1", "Schema 3"),
			func(st *otaState) { st.Schemas = st.Schemas[1:] }, ""},
		{"remove the last before a one-number gap", schemaOTA("Schema 0", "Schema 2"),
			func(st *otaState) { st.Schemas = nil }, ""},
	}
	for _, c := range cases {
		st := loadEditorState(t, c.src)
		st.MissionName = "Edited"
		c.edit(st)
		out, err := editOTA([]byte(c.src), st)
		if c.want == "" {
			if err != nil {
				t.Errorf("%s: %v", c.name, err)
			} else if !strings.Contains(string(out), "missionname=Edited;") {
				t.Errorf("%s: the edit was not written:\n%s", c.name, out)
			}
			continue
		}
		var editErr *otaEditError
		if !errors.As(err, &editErr) || editErr.field != "schemas" || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want an otaEditError naming %s", c.name, err, c.want)
			continue
		}
		if saveErrorStatus(err) != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", c.name, saveErrorStatus(err))
		}
		if out, warning, err := otaForSave(saveRequest{MapName: "gaps", TileW: 16, TileH: 16, OTA: st}); err == nil {
			t.Errorf("%s: otaForSave kept going (%d bytes, warning %q); want the error", c.name, len(out), warning)
		}
	}
}

// TestOTAStateInfiniteFractions checks a fraction the game reads as
// infinity (1e999) still gives the editor and the pack JSON they can
// encode, and that an untouched save keeps the value as the file has it.
func TestOTAStateInfiniteFractions(t *testing.T) {
	src := "[GlobalHeader]\n{\nmissionname=Huge;\nkillmul=1e999;\ntimemul=-1e999;\n[Schema 0]\n{\nType=Network 1;\n" +
		"MeteorDensity=1e999;\nMeteorInterval=-1e999;\n}\n}\n"
	st := loadEditorState(t, src)
	if st.Killmul != math.MaxFloat64 || st.Timemul != -math.MaxFloat64 {
		t.Errorf("killmul %v timemul %v, want the largest double and its negative", st.Killmul, st.Timemul)
	}
	if s := st.Schemas[0]; s.MeteorDensity != math.MaxFloat64 || s.MeteorInterval != -math.MaxFloat64 {
		t.Errorf("meteor density %v interval %v", s.MeteorDensity, s.MeteorInterval)
	}
	body, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("editor state does not encode: %v", err)
	}
	var back otaState
	if err := json.Unmarshal(body, &back); err != nil {
		t.Fatal(err)
	}
	out, err := editOTA([]byte(src), &back)
	if err != nil || string(out) != src {
		t.Errorf("untouched save: %v\n%s", err, out)
	}
	back.MissionName = "Huger"
	if out, err = editOTA([]byte(src), &back); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"killmul=1e999;", "timemul=-1e999;", "MeteorDensity=1e999;", "MeteorInterval=-1e999;", "missionname=Huger;"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("edited save lost %q:\n%s", want, out)
		}
	}
	if _, err := json.Marshal(packOTAState([]byte(src), false)); err != nil {
		t.Errorf("pack state does not encode: %v", err)
	}
}

// TestOTAForSaveKeepsUnreadableFile checks a source kbot-io cannot read is
// never overwritten: the save keeps its bytes and says why.
func TestOTAForSaveKeepsUnreadableFile(t *testing.T) {
	src := "[GlobalHeader\n{\nmissionname=Broken;\n}\n"
	st := readOTAState([]byte(src))
	if st.Error == "" {
		t.Fatalf("readOTAState accepted %q", src)
	}
	st.MissionName = "Changed"
	out, warning, err := otaForSave(saveRequest{MapName: "broken", TileW: 16, TileH: 16, OTA: st})
	if err != nil {
		t.Fatalf("otaForSave: %v", err)
	}
	if string(out) != src || warning == "" {
		t.Fatalf("got %q with warning %q; want the source unchanged and a warning", out, warning)
	}
}

// TestNewMapOTA checks a new map's .ota reads back with every value the
// editor holds, fractions included.
func TestNewMapOTA(t *testing.T) {
	st := otaState{
		MissionName: "Fresh", Planet: "Lunar", NumPlayers: "2, 4", Killmul: 0.5, TidalStrength: 7.5, SeaLevel: 20,
		Schemas: []otaSchema{{Type: "Network 1", AIProfile: "DEFAULT", MeteorDuration: 2.5,
			StartPos: []saveStartPos{{Number: 1, X: 100, Z: 100}, {Number: 2, X: 900, Z: 900}}}},
	}
	out, warning, err := otaForSave(saveRequest{MapName: "fresh", TileW: 32, TileH: 32, OTA: &st})
	if err != nil || warning != "" {
		t.Fatalf("otaForSave: %v %q", err, warning)
	}
	m, err := ta.ReadMap(out)
	if err != nil {
		t.Fatalf("reread: %v\n%s", err, out)
	}
	h := &m.Header
	if h.MissionName != "Fresh" || h.EffectiveKillMul() != 0.5 || h.EffectiveTidalStrength() != 7.5 || h.SeaLevel != 20 {
		t.Errorf("header = %+v", h.GlobalHeaderBase)
	}
	s := h.GameSchemas()
	if len(s) != 1 || len(s[0].StartPositions()) != 2 || s[0].EffectiveMeteorDuration() != 2.5 {
		t.Errorf("schemas = %+v", s)
	}
}

// TestKingdomsOTAState checks a TA: Kingdoms map's editor state holds its
// [Map Data] start positions in pixels.
func TestKingdomsOTAState(t *testing.T) {
	src := "[GlobalHeader]\n{\nkingdom=taros;\nnumplayers=8;\n[Map Data]\n{\nType=Network 1;\n[specials]\n{\n" +
		"[special0] { specialwhat=StartPos2; XPos=10; ZPos=20; }\n[special1] { specialwhat=StartPos1; XPos=30; ZPos=40; }\n}\n}\n}\n"
	st := readKingdomsOTAState([]byte(src))
	if st.Error != "" || len(st.Schemas) != 1 {
		t.Fatalf("state = %+v", st)
	}
	sp := st.Schemas[0].StartPos
	if len(sp) != 2 || sp[0].Number != 1 || sp[0].X != 30*16 || sp[0].Z != 40*16 {
		t.Errorf("start positions = %+v, want StartPos1 first at (480, 640)", sp)
	}
	if st.NumPlayers != "8" || st.Source != "" {
		t.Errorf("numplayers %q source %q", st.NumPlayers, st.Source)
	}
}

// TestEditOTARetailMapsUnchanged loads every retail TA map's .ota into the
// editor state and saves it untouched: the bytes must come back identical.
func TestEditOTARetailMapsUnchanged(t *testing.T) {
	dir := testutil.UnpackedDir(t, "maps")
	files, err := filepath.Glob(filepath.Join(dir, "*.ota"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no retail .ota files in %s", dir)
	}
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		st := readOTAState(data)
		if st.Error != "" {
			t.Errorf("%s: %s", filepath.Base(f), st.Error)
			continue
		}
		out, err := editOTA(data, st)
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(f), err)
			continue
		}
		if !bytes.Equal(out, data) {
			t.Errorf("%s: an untouched save changed the file", filepath.Base(f))
		}
		// And through the JSON the editor round-trips.
		if got := base64.StdEncoding.EncodeToString(data); st.Source != got {
			t.Errorf("%s: source not carried", filepath.Base(f))
		}
	}
}
