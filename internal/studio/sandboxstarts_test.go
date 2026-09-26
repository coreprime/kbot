package studio

import "testing"

// TestSandboxStartsGameRules checks the sandbox map's start positions come
// from the schema a multiplayer game uses (not the first schema in the
// file), numbered the game's way and in player-slot order, so the first is
// player 1's; an OTA with none offers none rather than invented ones.
func TestSandboxStartsGameRules(t *testing.T) {
	ota := `[GlobalHeader]
{
	[Schema 0] { Type=Easy; [specials] { [special0] { specialwhat=StartPos1; XPos=1; ZPos=1; } } }
	[Schema 1]
	{
		Type=Network 1;
		[specials]
		{
			[special0] { specialwhat=StartPos4; XPos=400; ZPos=40; }
			[special1] { specialwhat=StartPos2; XPos=200; ZPos=20; }
			[special2] { specialwhat=startpos1; XPos=100; ZPos=10; }
			[special3] { specialwhat=StartPos0; XPos=5; ZPos=5; }
		}
	}
}`
	starts := sandboxStarts([]byte(ota), false)
	var got [][2]int
	for _, p := range starts {
		got = append(got, [2]int{p.Number, p.Slot})
	}
	want := [][2]int{{1, 0}, {0, 0}, {2, 1}, {4, 3}}
	if len(got) != len(want) {
		t.Fatalf("starts = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("start %d = %v, want %v (number, slot)", i, got[i], want[i])
		}
	}
	if starts[0].X != 100 {
		t.Errorf("player 1 starts at x=%d, want StartPos1's 100", starts[0].X)
	}
	if got := sandboxStarts([]byte("[GlobalHeader] { missionname=x; }"), false); len(got) != 0 {
		t.Errorf("an OTA with no schema gave %d starts, want none", len(got))
	}
	tak := "[GlobalHeader]\n{\n[Map Data]\n{\n[specials]\n{\n[special0] { specialwhat=StartPos2; XPos=9; ZPos=9; }\n[special1] { specialwhat=StartPos1; XPos=3; ZPos=4; }\n}\n}\n}\n"
	if got := sandboxStarts([]byte(tak), true); len(got) != 2 || got[0].X != 3 || got[0].Number != 1 {
		t.Errorf("TA:K starts = %+v, want StartPos1 (3,4) first", got)
	}
}
