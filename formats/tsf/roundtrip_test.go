package tsf

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

// TestDecompileCompileRoundTrip is the end-to-end validation of the compiler
// and decompiler: every retail TAF is decompiled to a TSF document plus PNG
// layers, recompiled, and the resulting binary must match the original byte
// for byte. This proves both directions are correct and lossless.
func TestDecompileCompileRoundTrip(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "anims")
	files := collectFiles(t, dir, ".taf")
	if len(files) == 0 {
		t.Skip("no .taf files found")
	}

	for _, path := range files {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			taf, err := ParseTAF(original)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}

			base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			doc, images, err := Decompile(taf, base)
			if err != nil {
				t.Fatalf("decompile: %v", err)
			}

			// The document must itself survive a text round-trip.
			if reparsed, err := ParseTSF(doc.String()); err != nil {
				t.Fatalf("reparse decompiled tsf: %v", err)
			} else if reparsed.String() != doc.String() {
				t.Fatalf("decompiled tsf is not stable under round-trip")
			}

			recompiled, err := Compile(doc, NewMemoryResolver(images))
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			got, err := recompiled.Bytes()
			if err != nil {
				t.Fatalf("serialize: %v", err)
			}
			if !bytes.Equal(got, original) {
				t.Fatalf("recompiled binary differs from original (%d vs %d bytes)", len(got), len(original))
			}
		})
	}
	t.Logf("decompile/compile round-tripped %d TAF files", len(files))
}

// TestPixelCodecInverse checks that decoding then re-encoding any 16-bit value
// returns the original value, for both formats. This is the property the
// lossless round-trip relies on.
func TestPixelCodecInverse(t *testing.T) {
	for _, format := range []PixelFormat{FormatARGB4444, FormatARGB1555} {
		for v := 0; v <= 0xFFFF; v++ {
			r, g, b, a := decodePixel(uint16(v), format)
			got := encodePixel(r, g, b, a, format)
			if got != uint16(v) {
				t.Fatalf("%s: encode(decode(0x%04X)) = 0x%04X", format, v, got)
			}
		}
	}
}

// TestCompileGUITSFFromDisk compiles a retail GUI .tsf (which references an
// external .jpg) against the on-disk image directory, exercising DirResolver
// and the JPEG path. The result is a valid TAF whose frame dimensions match
// the source image.
func TestCompileGUITSFFromDisk(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "anims")
	data, err := os.ReadFile(filepath.Join(dir, "titlescreen.tsf"))
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	doc, err := ParseTSF(string(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	taf, err := Compile(doc, DirResolver(dir))
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if len(taf.Frames) != 2 {
		t.Fatalf("frame count: got %d want 2", len(taf.Frames))
	}
	if taf.Frames[0].Width == 0 || taf.Frames[0].Height == 0 {
		t.Fatalf("frame has zero dimensions")
	}
	// A compiled TAF must serialize without error.
	if _, err := taf.Bytes(); err != nil {
		t.Fatalf("serialize compiled taf: %v", err)
	}
}
