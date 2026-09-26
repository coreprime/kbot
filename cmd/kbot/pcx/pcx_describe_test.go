package pcx

import (
	"bytes"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/pcx"
)

// makePCX builds an 8-bit single-plane PCX of w×h pixels with the given
// version and BytesPerLine, RLE data for bpl bytes per row and a marked
// 768-byte palette.
func makePCX(version byte, w, h, bpl int) []byte {
	out := make([]byte, 128)
	out[0], out[1], out[2], out[3] = 0x0A, version, 1, 8
	out[8], out[9] = byte(w-1), byte((w-1)>>8)
	out[10], out[11] = byte(h-1), byte((h-1)>>8)
	out[65] = 1
	out[66], out[67] = byte(bpl), byte(bpl>>8)
	for y := 0; y < h; y++ {
		for x := 0; x < bpl; x++ {
			out = append(out, 0xC1, byte(x+1))
		}
	}
	out = append(out, 0x0C)
	return append(out, make([]byte, 768)...)
}

func compatText(t *testing.T, data []byte) string {
	t.Helper()
	r, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	printPCXCompat(&buf, r.Compat())
	return buf.String()
}

func TestDescribeSaysWhatTheGameDoes(t *testing.T) {
	if got := compatText(t, makePCX(5, 4, 2, 4)); !strings.Contains(got, "loads this file and draws it as shown") {
		t.Errorf("clean file:\n%s", got)
	}
	got := compatText(t, makePCX(5, 3, 2, 4))
	if !strings.Contains(got, "draw it differently") || !strings.Contains(got, "BytesPerLine is 4 but the width is 3") {
		t.Errorf("padded rows:\n%s", got)
	}
	got = compatText(t, makePCX(3, 4, 2, 4))
	if !strings.Contains(got, "refuse to load") || !strings.Contains(got, "version 3") {
		t.Errorf("version 3:\n%s", got)
	}
}
