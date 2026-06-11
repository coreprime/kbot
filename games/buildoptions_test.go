package games

import "testing"

// fakeVFS is a map-backed games.VFS for download-mechanism tests.
type fakeVFS map[string]string

func (f fakeVFS) ReadFile(p string) ([]byte, error) {
	if s, ok := f[p]; ok {
		return []byte(s), nil
	}
	return nil, errNotFound
}
func (f fakeVFS) Exists(p string) bool { _, ok := f[p]; return ok }
func (f fakeVFS) List() []string {
	out := make([]string, 0, len(f))
	for k := range f {
		out = append(out, k)
	}
	return out
}

type notFoundError struct{}

func (notFoundError) Error() string { return "not found" }

var errNotFound = notFoundError{}

func TestDownloadMenuOptionsAppendsToBuilder(t *testing.T) {
	fs := fakeVFS{
		"gamedata/sidedata.tdf": `
[CANBUILD]
	{
	[ARMALAB]
		{
		canbuild1=ARMACK;
		canbuild2=ARMFARK_NOT;
		}
	}`,
		// The AFark.ufo mechanism: a download TDF adds ARMFARK to the
		// Advanced Kbot Lab's menu.
		"download/ARMFARK.TDF": `
[MENUENTRY1]
	{
	UNITMENU=ARMALAB;
	MENU=4;
	BUTTON=2;
	UNITNAME=ARMFARK;
	}`,
	}
	base := SidedataBuildOptions(fs)
	extra := DownloadMenuOptions(fs)
	got := MergeBuildOptions(base["ARMALAB"], extra["ARMALAB"])
	want := []string{"armack", "armfark_not", "armfark"}
	if len(got) != len(want) {
		t.Fatalf("merged = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("merged[%d] = %q, want %q (full %v)", i, got[i], want[i], got)
		}
	}
}
