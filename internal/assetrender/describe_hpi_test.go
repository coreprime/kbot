package assetrender

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
)

// TestDescribeHPIReportsGameMount: the Files tab's describe of an archive
// says whether TA 3.1c would mount it.
func TestDescribeHPIReportsGameMount(t *testing.T) {
	for _, tc := range []struct {
		noTrailer bool
		want      string
	}{
		{false, "TA 3.1c would mount: yes"},
		{true, "TA 3.1c would mount: no, "},
	} {
		path := filepath.Join(t.TempDir(), "x.hpi")
		w, err := hpiv1.CreateWriter(path)
		if err != nil {
			t.Fatal(err)
		}
		if tc.noTrailer {
			w.AllowNonGameTrailer = true
			w.SetTrailer(nil)
		}
		_ = w.AddFileFromBytes("a.txt", []byte("a"))
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]any{}
		describeHPI(nil, "mods/x.hpi", data, out)
		line, _ := out["gameMount"].(string)
		if !strings.HasPrefix(line, tc.want) || out["gameMountable"] != !tc.noTrailer || out["headerKey"] != "0xBF (XOR key 0xFE)" {
			t.Errorf("noTrailer=%v: describe = %v", tc.noTrailer, out)
		}
	}
}
