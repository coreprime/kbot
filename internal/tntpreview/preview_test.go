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
