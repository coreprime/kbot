package mapmeta

import (
	"fmt"
	"reflect"
	"sort"
	"testing"
)

const campaignAndNetworkOTA = `[GlobalHeader]
	{
	missionname=Test;
	[Schema 0]
		{
		Type=Easy;
		[specials]
			{
			[special0] { specialwhat=StartPos1; XPos=10; ZPos=20; }
			}
		}
	[schema 1]
		{
		Type=network 1;
		[Specials]
			{
			[special0] { specialwhat=startpos3; XPos=300; ZPos=310; }
			[special1] { specialwhat=StartPos0; XPos=0; ZPos=5; }
			[special2] { specialwhat=StartPos; XPos=100; ZPos=110; }
			[special3] { specialwhat=MetalSpot; XPos=1; ZPos=1; }
			[special4] { specialwhat=StartPosB; XPos=200; ZPos=210; }
			}
		}
	[Schema 3]
		{
		Type=Network 1;
		[specials]
			{
			[special0] { specialwhat=StartPos1; XPos=1; ZPos=1; }
			[special1] { specialwhat=StartPos2; XPos=2; ZPos=2; }
			[special2] { specialwhat=StartPos3; XPos=3; ZPos=3; }
			[special3] { specialwhat=StartPos4; XPos=4; ZPos=4; }
			[special4] { specialwhat=StartPos5; XPos=5; ZPos=5; }
			[special5] { specialwhat=StartPos6; XPos=6; ZPos=6; }
			}
		}
	}
`

type startRow struct{ Number, Slot, X, Z int }

// TestStartSchemaUsesTheGamesChoice checks that the schema kbot shows is the
// one a multiplayer game uses (a Network schema, found case-insensitively and
// only up to the first gap in the numbering), and that its start positions
// are numbered the game's way and ordered by player slot.
func TestStartSchemaUsesTheGamesChoice(t *testing.T) {
	m, err := ReadOTA([]byte(campaignAndNetworkOTA))
	if err != nil {
		t.Fatalf("ReadOTA: %v", err)
	}
	h := &m.Header
	if got := len(h.GameSchemas()); got != 2 {
		t.Fatalf("game schemas = %d, want 2 (Schema 3 follows a gap)", got)
	}
	if GameSchema(h, 2) != nil {
		t.Errorf("GameSchema(2) should be nil: the game never reads past the gap")
	}
	s := StartSchema(h)
	if s == nil || s.Key != "schema 1" {
		t.Fatalf("StartSchema = %v, want [schema 1] (the Network 1 schema, not Easy Schema 0 or unreachable Schema 3)", s)
	}
	var got []startRow
	for _, p := range StartPositions(s) {
		got = append(got, startRow{p.Number, p.Slot, p.X, p.Z})
	}
	want := []startRow{
		{0, 0, 0, 5},     // StartPos0 is slot 0
		{1, 0, 100, 110}, // unnumbered: first such entry is 1, slot 0
		{2, 1, 200, 210}, // "StartPosB" has no digits: second unnumbered entry
		{3, 2, 300, 310}, // startpos3, matched ignoring case
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("start positions = %+v\nwant %+v", got, want)
	}
}

// TestStartSchemaCampaign checks that a campaign mission with no Network
// schema shows its medium-difficulty schema's start.
func TestStartSchemaCampaign(t *testing.T) {
	ota := `[GlobalHeader] { [Schema 0] { Type=Easy; [specials] { [special0] { specialwhat=StartPos1; XPos=1; ZPos=1; } } }
	[Schema 1] { Type=Medium; [specials] { [special0] { specialwhat=StartPos1; XPos=2; ZPos=2; } } } }`
	m, err := ReadOTA([]byte(ota))
	if err != nil {
		t.Fatalf("ReadOTA: %v", err)
	}
	s := StartSchema(&m.Header)
	if s == nil || s.Type != "Medium" {
		t.Fatalf("StartSchema = %+v, want the Medium schema", s)
	}
}

// TestKingdomsSetup reads a TA: Kingdoms [Map Data] section with the same
// start-position rules.
func TestKingdomsSetup(t *testing.T) {
	ota := `[GlobalHeader]
{
	kingdom=taros;
	[Map Data]
	{
		Type=Network 1;
		[specials]
		{
			[special0] { specialwhat=StartPos2; XPos=55; ZPos=291; }
			[special1] { specialwhat=StartPos1; XPos=291; ZPos=11; }
		}
	}
}`
	s, err := KingdomsSetup([]byte(ota))
	if err != nil || s == nil {
		t.Fatalf("KingdomsSetup = %v, %v", s, err)
	}
	ps := StartPositions(s)
	if len(ps) != 2 || ps[0].Number != 1 || ps[0].X != 291 || ps[1].Number != 2 {
		t.Fatalf("start positions = %+v, want StartPos1 first", ps)
	}
	if s, err := KingdomsSetup([]byte("[GlobalHeader] { missionname=x; }")); err != nil || s != nil {
		t.Errorf("no [Map Data]: got %v, %v; want nil, nil", s, err)
	}
}

type fakeFS map[string]string

func (f fakeFS) List() []string {
	out := make([]string, 0, len(f))
	for k := range f {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (f fakeFS) ReadFile(p string) ([]byte, error) {
	if s, ok := f[p]; ok {
		return []byte(s), nil
	}
	return nil, fmt.Errorf("%s: not found", p)
}

// TestFeatureMetal checks the game's metal reading: a whole number read with
// Atol and kept to 16 bits, the first definition of a name winning.
func TestFeatureMetal(t *testing.T) {
	fs := fakeFS{
		"features/corpses/arm.tdf": `[armfrt_dead] { metal=56.8; } [armsjam_dead] { metal=104.8; }`,
		"features/rocks/big.tdf":   `[BigRock] { metal=70000; } [Pebble] { metal=0; } [Dust] { energy=5; }`,
		"features/rocks/dup.tdf":   `[bigrock] { metal=5; } [ARMFRT_DEAD] { metal=9; }`,
		"units/armcom.fbi":         `[UNITINFO] { metal=100; }`,
	}
	got := FeatureMetal(fs)
	want := map[string]int{"armfrt_dead": 56, "armsjam_dead": 104, "bigrock": 4464}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("FeatureMetal = %v, want %v", got, want)
	}
	if got := FeatureMetal(nil); len(got) != 0 {
		t.Errorf("FeatureMetal(nil) = %v, want empty", got)
	}
}
