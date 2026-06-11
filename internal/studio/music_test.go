package studio

import (
	"sort"
	"testing"
)

// sortTracks applies handleMusicList's ordering to a name list.
func sortTracks(names []string) []string {
	out := append([]string(nil), names...)
	sort.Slice(out, func(i, j int) bool {
		pi, ni, ok1 := musicNaturalKey(out[i])
		pj, nj, ok2 := musicNaturalKey(out[j])
		if ok1 && ok2 {
			if pi != pj {
				return pi < pj
			}
			if ni != nj {
				return ni < nj
			}
		}
		return out[i] < out[j]
	})
	return out
}

func TestMusicNaturalOrderTA(t *testing.T) {
	got := sortTracks([]string{"10.mp3", "2.mp3", "0.mp3", "1.mp3", "17.mp3"})
	want := []string{"0.mp3", "1.mp3", "2.mp3", "10.mp3", "17.mp3"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("TA order[%d] = %s, want %s (full: %v)", i, got[i], want[i], got)
		}
	}
}

func TestMusicNaturalOrderTAK(t *testing.T) {
	got := sortTracks([]string{"track10.wav", "track2.wav", "track1.wav", "track11.wav"})
	want := []string{"track1.wav", "track2.wav", "track10.wav", "track11.wav"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("TA:K order[%d] = %s, want %s (full: %v)", i, got[i], want[i], got)
		}
	}
}

func TestMusicNaturalOrderMixedAndPlain(t *testing.T) {
	got := sortTracks([]string{"zz.ogg", "battle2.ogg", "ambient.ogg", "battle10.ogg"})
	want := []string{"ambient.ogg", "battle2.ogg", "battle10.ogg", "zz.ogg"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("mixed order[%d] = %s, want %s (full: %v)", i, got[i], want[i], got)
		}
	}
}
