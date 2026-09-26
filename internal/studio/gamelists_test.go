package studio

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
)

func testVFS(t *testing.T, files map[string]string) *filesystem.VirtualFileSystem {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return vfs
}

func unitFBI(name, extra string) string {
	return "[UNITINFO]\n{\n\tUnitName=" + name + ";\n" + extra + "}\n"
}

// The build menu the unit viewer shows and the sandbox builds from follows
// the game's rules for [CANBUILD] and download/*.tdf.
func TestBuildOptionsFollowTheGame(t *testing.T) {
	vfs := testVFS(t, map[string]string{
		"units/armcom.fbi":  unitFBI("ARMCOM", "\tBuilder=1;\n"),
		"units/armlab.fbi":  unitFBI("ARMLAB", "\tBuilder=1;\n"),
		"units/armpw.fbi":   unitFBI("ARMPW", ""),
		"units/armflea.fbi": unitFBI("ARMFLEA", ""),
		"units/armjeth.fbi": unitFBI("ARMJETH", ""),
		"gamedata/sidedata.tdf": "[CANBUILD]\n{\n" +
			"\t[ARMCOM]\n\t{\n\t\tcanbuild1=ARMLAB;\n\t\tcanbuild2=NOSUCHUNIT;\n\t\tcanbuild3=ARMPW;\n\t\tcanbuild5=ARMJETH;\n\t}\n" +
			"\t[ARMPW]\n\t{\n\t\tcanbuild1=ARMLAB;\n\t}\n" +
			"}\n",
		"download/add.tdf": "[ENTRY0]\n{\n\tUNITMENU=ARMCOM;\n\tMENU=2;\n\tBUTTON=0;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E2]\n{\n\tUNITMENU=ARMPW;\n\tMENU=2;\n\tBUTTON=1;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E3]\n{\n\tUNITMENU=ARMCOM;\n\tMENU=2;\n\tBUTTON=2;\n\tUNITNAME=NOSUCHUNIT;\n}\n" +
			"[E4]\n{\n\tUNITMENU=ARMLAB;\n\tMENU=2;\n\tBUTTON=3;\n\tUNITNAME=ARMFLEA;\n}\n" +
			"[E5]\n{\n\tUNITMENU=ARMLAB;\n\tMENU=2;\n\tBUTTON=4;\n\tUNITNAME=ARMPW;\n}\n" +
			"[E6]\n{\n\tUNITMENU=ARMCOM;\n\tMENU=2;\n\tBUTTON=5;\n\tUNITNAME=ARMJETH;\n}\n",
	})
	sess := &Session{vfs: vfs, game: "totala"}
	for unit, want := range map[string]string{
		// NOSUCHUNIT skipped, stop at the gap before canbuild5; ENTRY0 counts
		// although it is not named MENUENTRY; E6 is the sixth section.
		"ARMCOM": "armlab,armpw,armflea",
		"ARMLAB": "armflea,armpw",
		// No Builder=1: no list from [CANBUILD] or download entries.
		"ARMPW": "",
	} {
		if got := strings.Join(sess.buildOptions(unit), ","); got != want {
			t.Errorf("%s build options = %q, want %q", unit, got, want)
		}
	}
}

// The sandbox side picker offers only the sides the game reads: SIDE0,
// SIDE1, ... up to the first gap.
func TestSandboxSidesFollowTheGame(t *testing.T) {
	side := func(n, name, cmdr string) string {
		return "[SIDE" + n + "]\n{\n\tname=" + name + ";\n\tcommander=" + cmdr + ";\n}\n"
	}
	vfs := testVFS(t, map[string]string{
		"gamedata/sidedata.tdf": side("0", "ARM", "ARMCOM") + side("1", "CORE", "CORCOM") +
			side("3", "GAP", "GAPCOM") + side("01", "ODD", "ODDCOM"),
	})
	for _, tc := range []struct {
		game string
		want string
	}{
		{"totala", "0:ARM 1:CORE"},
		{"takingdoms", "0:ARM 1:CORE 2:GAP 3:ODD"},
	} {
		sess := &Session{vfs: vfs, game: tc.game}
		rec := httptest.NewRecorder()
		sess.handleSandboxSides(rec, httptest.NewRequest("GET", "/api/studio/sandbox-sides", nil))
		var sides []sandboxSideJSON
		if err := json.Unmarshal(rec.Body.Bytes(), &sides); err != nil {
			t.Fatalf("%s: %v\n%s", tc.game, err, rec.Body.String())
		}
		var got []string
		for _, s := range sides {
			got = append(got, strconv.Itoa(s.Index)+":"+s.Name)
		}
		if strings.Join(got, " ") != tc.want {
			t.Errorf("%s sides = %v, want %s", tc.game, got, tc.want)
		}
	}
}
