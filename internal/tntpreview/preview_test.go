package tntpreview

import (
	"testing"
)

// TestExtractStartPositionsForSchema asserts the per-schema selector
// returns the StartPos set for the schema it was asked for — and
// returns nil (not Schema 0's set) when the requested schema doesn't
// exist.  The previous Compose pipeline was hardcoded to Schema 0,
// which the studio's "Export Full Render" menu item can now override.
func TestExtractStartPositionsForSchema(t *testing.T) {
	const ota = `
[GlobalHeader]
	{
	missionname=Toy;
	[Schema 0]
		{
		[specials]
			{
			[special0]
				{
				specialwhat=StartPos1;
				XPos=100;
				ZPos=100;
				}
			[special1]
				{
				specialwhat=StartPos2;
				XPos=200;
				ZPos=200;
				}
			}
		}
	[Schema 1]
		{
		[specials]
			{
			[special0]
				{
				specialwhat=StartPos3;
				XPos=300;
				ZPos=300;
				}
			}
		}
	}
`
	cases := []struct {
		name     string
		schema   int
		wantNums []int
	}{
		{name: "schema-0", schema: 0, wantNums: []int{1, 2}},
		{name: "schema-1", schema: 1, wantNums: []int{3}},
		{name: "schema-missing", schema: 7, wantNums: nil},
		{name: "back-compat-default", schema: -1, wantNums: nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ExtractStartPositionsForSchema(ota, c.schema)
			if len(got) != len(c.wantNums) {
				t.Fatalf("count: got %d, want %d (positions=%+v)", len(got), len(c.wantNums), got)
			}
			for i, n := range c.wantNums {
				if got[i].Number != n {
					t.Errorf("position %d: got Number=%d, want %d", i, got[i].Number, n)
				}
			}
		})
	}

	// ExtractStartPositions (the bare wrapper) must still match Schema 0.
	bare := ExtractStartPositions(ota)
	if len(bare) != 2 {
		t.Errorf("ExtractStartPositions: got %d, want 2 (Schema 0 set)", len(bare))
	}
}

// TestExtractStartPositionsGameRules checks the preview reads start
// positions as the game does: names ignore case, StartPos0 and unnumbered
// entries count, and a schema after a gap in the numbering is never read.
func TestExtractStartPositionsGameRules(t *testing.T) {
	const ota = `[GlobalHeader]
{
	[schema 0]
	{
		[Specials]
		{
			[special0] { specialwhat=startpos2; XPos=200; ZPos=210; }
			[special1] { specialwhat=StartPos0; XPos=5; ZPos=6; }
			[special2] { specialwhat=StartPos; XPos=100; ZPos=110; }
		}
	}
	[Schema 2] { [specials] { [special0] { specialwhat=StartPos1; XPos=1; ZPos=1; } } }
}`
	got := ExtractStartPositionsForSchema(ota, 0)
	want := []StartPos{{Number: 0, X: 5, Y: 6}, {Number: 1, X: 100, Y: 110}, {Number: 2, X: 200, Y: 210}}
	if len(got) != len(want) {
		t.Fatalf("schema 0: got %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("position %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
	if got := ExtractStartPositionsForSchema(ota, 2); got != nil {
		t.Errorf("schema 2 follows a gap; got %+v, want nil", got)
	}
}
