package gaf

import (
	"bytes"
	"errors"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/palettes"
	"github.com/coreprime/kbot-io/testutil"
)

func testPalette(t *testing.T) *gaf.Palette {
	t.Helper()
	p, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatalf("palette: %v", err)
	}
	return p
}

// testSequences returns sequences that exercise every field the dump folder
// has to carry: a looping sequence with a +4 word, a raw frame whose black
// pixels (index 0) must stay opaque, a compressed frame with the +11 byte
// set, and a sequence that plays once.
func testSequences() []*gaf.Sequence {
	raw := &gaf.Frame{
		Width: 3, Height: 2, OriginX: 1, OriginY: -2,
		TransparencyIndex: 9, Duration: 2, Storage: gaf.StorageRaw,
		Pixels: []byte{0, 9, 40, 9, 0, 200},
	}
	compressed := &gaf.Frame{
		Width: 2, Height: 2, TransparencyIndex: 0, Duration: 0,
		Storage: gaf.StorageCompressed, Blend: 1,
		Pixels: []byte{0, 17, 17, 0},
	}
	looping := &gaf.Sequence{Name: "Spin", Frames: []*gaf.Frame{raw, compressed}, LoopFlags: 1, Unknown4: 7}
	once := &gaf.Sequence{Name: "Boom", Frames: []*gaf.Frame{{
		Width: 1, Height: 1, TransparencyIndex: 9, Duration: 3,
		Storage: gaf.StorageCompressed, Pixels: []byte{5},
	}}}
	return []*gaf.Sequence{looping, once}
}

func encode(t *testing.T, seqs []*gaf.Sequence) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := gaf.WriteGAF(&buf, seqs); err != nil {
		t.Fatalf("WriteGAF: %v", err)
	}
	return buf.Bytes()
}

// dumpAndBuild runs the dump and build code the CLI uses, with its default
// flags, writing the result as if to target.
func dumpAndBuild(t *testing.T, seqs []*gaf.Sequence, target string) []*gaf.Sequence {
	t.Helper()
	dir := t.TempDir()
	pal := testPalette(t)
	if _, err := dumpSequences(seqs, pal, dir, dumpOptions{Format: "png", Animated: true}); err != nil {
		t.Fatalf("dump: %v", err)
	}
	policy, err := parseStoragePolicy("auto", target)
	if err != nil {
		t.Fatal(err)
	}
	built, err := buildSequences(dir, pal, policy, func(d string, _ *gaf.Sequence, err error) {
		if err != nil {
			t.Fatalf("build %s: %v", d, err)
		}
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var buf bytes.Buffer
	if err := gaf.WriteGAFWith(&buf, built, policy.writeOptions()); err != nil {
		t.Fatalf("write: %v", err)
	}
	out, err := loadGAFSequences(buf.Bytes())
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	return out
}

func TestDumpBuildKeepsLoopStorageAndBlend(t *testing.T) {
	orig, err := loadGAFSequences(encode(t, testSequences()))
	if err != nil {
		t.Fatal(err)
	}
	got := dumpAndBuild(t, orig, filepath.Join("mod", "anims", "fx.gaf"))

	if diff := compareSequences(orig, got); diff != "" {
		t.Fatalf("dump/build changed the sequences: %s", diff)
	}
	if got[0].Name != "Spin" || got[1].Name != "Boom" {
		t.Errorf("sequence order/names = %q, %q; want Spin, Boom", got[0].Name, got[1].Name)
	}
	if got[0].LoopFlags != 1 || got[0].Unknown4 != 7 {
		t.Errorf("seq 0 words = loop 0x%X, +4 %d; want 1, 7", got[0].LoopFlags, got[0].Unknown4)
	}
	if got[1].Loops() {
		t.Errorf("seq 1 plays once in the original but loops after dump/build")
	}
	if s := got[0].Frames[0].Storage; s != gaf.StorageRaw {
		t.Errorf("raw frame came back %s", s)
	}
	if s := got[0].Frames[1].Storage; s != gaf.StorageCompressed {
		t.Errorf("compressed frame came back %s", s)
	}
	if b := got[0].Frames[1].Blend; b != 1 {
		t.Errorf("+11 byte = %d, want 1", b)
	}
	// Palette index 0 is opaque black in the game; only the key (9) is
	// transparent in a raw frame.
	f := got[0].Frames[0]
	if !f.PixelOpaque(0) || f.Pixels[0] != 0 {
		t.Errorf("black pixel lost: value %d drawn=%v", f.Pixels[0], f.PixelOpaque(0))
	}
	if f.PixelOpaque(1) {
		t.Errorf("key pixel is drawn")
	}
}

func TestDumpBuildKeepsKeyValuedPixelsOfCompressedFrames(t *testing.T) {
	// A compressed frame can draw a pixel whose value equals its key; only
	// its skipped pixels are transparent.
	f := &gaf.Frame{
		Width: 3, Height: 1, TransparencyIndex: 9, Duration: 1,
		Storage: gaf.StorageCompressed,
		Pixels:  []byte{9, 9, 30},
		Opaque:  []bool{true, false, true},
	}
	orig, err := loadGAFSequences(encode(t, []*gaf.Sequence{{Name: "k", LoopFlags: 1, Frames: []*gaf.Frame{f}}}))
	if err != nil {
		t.Fatal(err)
	}
	if !orig[0].Frames[0].PixelOpaque(0) {
		t.Fatal("test setup: key-valued literal should be drawn")
	}
	got := dumpAndBuild(t, orig, "fx.gaf")
	if diff := compareSequences(orig, got); diff != "" {
		t.Fatalf("dump/build changed the frame: %s", diff)
	}
}

func TestBuildDefaultsLoopAndStorageFromPath(t *testing.T) {
	// A hand-made folder: no sequence.csv, no storage column.
	src := t.TempDir()
	seqDir := filepath.Join(src, "glow")
	if err := os.MkdirAll(seqDir, 0o755); err != nil {
		t.Fatal(err)
	}
	csv := "frame,width,height,origin_x,origin_y,transparency,duration_ticks\n0,2,1,0,0,9,2\n"
	if err := os.WriteFile(filepath.Join(seqDir, framesCSVName), []byte(csv), 0o644); err != nil {
		t.Fatal(err)
	}
	pal := testPalette(t)
	var img bytes.Buffer
	frame := &gaf.Frame{Width: 2, Height: 1, TransparencyIndex: 9, Pixels: []byte{0, 80}}
	if err := frame.ToPNG(pal, &img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(seqDir, "0.png"), img.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		target, flag string
		want         gaf.FrameStorage
	}{
		{"glow.gaf", "auto", gaf.StorageCompressed},
		{filepath.Join("mod", "textures", "glow.gaf"), "auto", gaf.StorageRaw},
		{filepath.Join("anims", "vismasks.gaf"), "auto", gaf.StorageRaw},
		{"glow.gaf", "raw", gaf.StorageRaw},
	} {
		policy, err := parseStoragePolicy(tc.flag, tc.target)
		if err != nil {
			t.Fatal(err)
		}
		seqs, err := buildSequences(src, pal, policy, nil)
		if err != nil {
			t.Fatalf("%s: build: %v", tc.target, err)
		}
		var buf bytes.Buffer
		if err := gaf.WriteGAFWith(&buf, seqs, policy.writeOptions()); err != nil {
			t.Fatal(err)
		}
		got, err := loadGAFSequences(buf.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if !got[0].Loops() {
			t.Errorf("%s: a new sequence should loop like every stock sequence", tc.target)
		}
		if s := got[0].Frames[0].Storage; s != tc.want {
			t.Errorf("%s --storage %s: frame stored %s, want %s", tc.target, tc.flag, s, tc.want)
		}
		if got[0].Frames[0].Pixels[0] != 0 || !got[0].Frames[0].PixelOpaque(0) {
			t.Errorf("%s: black pixel became transparent", tc.target)
		}
	}
	if _, err := parseStoragePolicy("sideways", "x.gaf"); err == nil {
		t.Error("unknown --storage value accepted")
	}
}

func TestBuildForcesRawForTexturesOverCSV(t *testing.T) {
	orig, err := loadGAFSequences(encode(t, testSequences()))
	if err != nil {
		t.Fatal(err)
	}
	got := dumpAndBuild(t, orig, filepath.Join("textures", "fx.gaf"))
	for si, s := range got {
		for fi, f := range s.Frames {
			if f.Storage != gaf.StorageRaw {
				t.Errorf("seq %d frame %d stored %s in textures/", si, fi, f.Storage)
			}
		}
	}
}

func TestRawFieldCompareCatchesLostHeaderFields(t *testing.T) {
	seqs, err := loadGAFSequences(encode(t, testSequences()))
	if err != nil {
		t.Fatal(err)
	}
	origRaw, err := readRawFields(encode(t, seqs))
	if err != nil {
		t.Fatal(err)
	}
	if diff := compareEncoded(seqs, origRaw, encode(t, seqs), rawCompareOptions{}); diff != "" {
		t.Fatalf("identical re-encode reported: %s", diff)
	}

	cases := map[string]func(s []*gaf.Sequence){
		"loop word": func(s []*gaf.Sequence) { s[0].LoopFlags = 0 },
		"+4 word":   func(s []*gaf.Sequence) { s[0].Unknown4 = 0 },
		"storage":   func(s []*gaf.Sequence) { s[0].Frames[0].Storage = gaf.StorageCompressed },
		"+11 byte":  func(s []*gaf.Sequence) { s[0].Frames[1].Blend = 0 },
		"duration":  func(s []*gaf.Sequence) { s[1].Frames[0].Duration = 4 },
	}
	for want, mutate := range cases {
		changed, err := loadGAFSequences(encode(t, seqs))
		if err != nil {
			t.Fatal(err)
		}
		mutate(changed)
		diff := compareEncoded(seqs, origRaw, encode(t, changed), rawCompareOptions{})
		if !strings.Contains(diff, want) {
			t.Errorf("changing the %s: compare said %q", want, diff)
		}
	}
}

func TestRoundtripPassesAndFlagsComposites(t *testing.T) {
	layer := &gaf.Frame{Width: 2, Height: 2, OriginX: 1, OriginY: 1, TransparencyIndex: 9,
		Storage: gaf.StorageCompressed, Pixels: []byte{9, 3, 3, 9}}
	composite := &gaf.Frame{Width: 2, Height: 2, OriginX: 1, OriginY: 1, TransparencyIndex: 9,
		Duration: 1, Storage: gaf.StorageCompressed, Layers: []*gaf.Frame{layer}}
	dir := t.TempDir()
	path := filepath.Join(dir, "tree.gaf")
	data := encode(t, []*gaf.Sequence{{Name: "tree", LoopFlags: 1, Frames: []*gaf.Frame{composite}}})
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	r := testOneGAF(path, testPalette(t), false)
	if !r.EncodeOK || !r.BuildOK {
		t.Fatalf("roundtrip failed: encode=%v (%s) build=%v (%s)", r.EncodeOK, r.EncodeErr, r.BuildOK, r.BuildErr)
	}
	if r.Flattened != 1 {
		t.Errorf("flattened = %d, want 1", r.Flattened)
	}
}

func TestDumpAndExportDefaultToPNG(t *testing.T) {
	if d := newGAFDumpCommand().Flags().Lookup("format").DefValue; d != "png" {
		t.Errorf("dump --format default = %q, want png", d)
	}
	if d := newGAFExportCommand().Flags().Lookup("format").DefValue; d != "png" {
		t.Errorf("export --format default = %q, want png", d)
	}
	if d := newGAFExportCommand().Flags().Lookup("transparency").DefValue; d != "game" {
		t.Errorf("export --transparency default = %q, want game", d)
	}
}

func TestDumpedFrameKeepsBlackOpaque(t *testing.T) {
	dir := t.TempDir()
	seqs := testSequences()
	if _, err := dumpSequences(seqs, testPalette(t), dir, dumpOptions{Format: "png"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "Spin", "0.png"))
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(0, 0).RGBA(); a != 0xffff {
		t.Errorf("index 0 pixel alpha = %d, want opaque", a)
	}
	if _, _, _, a := img.At(1, 0).RGBA(); a != 0 {
		t.Errorf("key pixel alpha = %d, want transparent", a)
	}
	for _, f := range []string{framesCSVName, sequenceCSVName} {
		if _, err := os.Stat(filepath.Join(dir, "Spin", f)); err != nil {
			t.Errorf("dump folder lacks %s: %v", f, err)
		}
	}
}

func TestDumpKeepsSameNamedSequencesApart(t *testing.T) {
	seqs := []*gaf.Sequence{
		{Name: "dup", LoopFlags: 1, Frames: []*gaf.Frame{{Width: 1, Height: 1, Pixels: []byte{1}, Duration: 1}}},
		{Name: "dup", LoopFlags: 1, Frames: []*gaf.Frame{{Width: 1, Height: 1, Pixels: []byte{2}, Duration: 1}}},
	}
	orig, err := loadGAFSequences(encode(t, seqs))
	if err != nil {
		t.Fatal(err)
	}
	got := dumpAndBuild(t, orig, "dup.gaf")
	if diff := compareSequences(orig, got); diff != "" {
		t.Fatalf("same-named sequences collided: %s", diff)
	}
}

// TestDumpBuildKeepsUniformCorners checks a raw frame whose four corners
// share a colour (index 0) and whose key does not occur. The game draws
// every pixel of it; a corner guess would make the corners transparent,
// and the build would then write the key over them.
func TestDumpBuildKeepsUniformCorners(t *testing.T) {
	f := &gaf.Frame{
		Width: 3, Height: 3, TransparencyIndex: 9, Duration: 1,
		Storage: gaf.StorageRaw,
		Pixels: []byte{
			0, 40, 0,
			40, 40, 40,
			0, 40, 0,
		},
	}
	orig, err := loadGAFSequences(encode(t, []*gaf.Sequence{{Name: "plate", LoopFlags: 1, Frames: []*gaf.Frame{f}}}))
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if _, err := dumpSequences(orig, testPalette(t), dir, dumpOptions{Format: "png"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "plate", "0.png"))
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 3; y++ {
		for x := 0; x < 3; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a != 0xffff {
				t.Errorf("pixel %d,%d alpha = %d, want opaque", x, y, a)
			}
		}
	}

	got := dumpAndBuild(t, orig, "plate.gaf")
	if diff := compareSequences(orig, got); diff != "" {
		t.Fatalf("dump/build changed the frame: %s", diff)
	}
	if g := got[0].Frames[0]; g.Pixels[0] != 0 || !g.PixelOpaque(0) {
		t.Errorf("corner came back as %d (drawn %v), want 0 drawn", g.Pixels[0], g.PixelOpaque(0))
	}
}

// TestDumpBuildKeepsEmptyFrames checks that a frame with no pixels survives
// dump and build: it gets no image, and the build restores it from
// frames.csv instead of dropping its sequence.
func TestDumpBuildKeepsEmptyFrames(t *testing.T) {
	seqs := []*gaf.Sequence{
		{Name: "blink", LoopFlags: 1, Frames: []*gaf.Frame{
			{Width: 1, Height: 1, TransparencyIndex: 9, Duration: 2, Storage: gaf.StorageCompressed, Pixels: []byte{5}},
			{Width: 0, Height: 0, OriginX: 3, OriginY: -1, TransparencyIndex: 9, Duration: 4, Storage: gaf.StorageCompressed},
		}},
		{Name: "nothing", LoopFlags: 1, Frames: []*gaf.Frame{
			{Width: 0, Height: 0, TransparencyIndex: 9, Duration: 1, Storage: gaf.StorageRaw},
		}},
	}
	orig, err := loadGAFSequences(encode(t, seqs))
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if _, err := dumpSequences(orig, testPalette(t), dir, dumpOptions{Format: "png", Animated: true}); err != nil {
		t.Fatalf("dump: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "blink", "1.png")); !os.IsNotExist(err) {
		t.Errorf("an image was written for the empty frame (stat err %v)", err)
	}

	got := dumpAndBuild(t, orig, "blink.gaf")
	if len(got) != 2 {
		t.Fatalf("built %d sequences, want 2", len(got))
	}
	if diff := compareSequences(orig, got); diff != "" {
		t.Fatalf("dump/build changed the sequences: %s", diff)
	}
	if f := got[0].Frames[1]; f.Width != 0 || f.Height != 0 || f.OriginX != 3 || f.OriginY != -1 || f.Duration != 4 {
		t.Errorf("empty frame came back %dx%d origin %d,%d duration %d", f.Width, f.Height, f.OriginX, f.OriginY, f.Duration)
	}
}

// TestBuildFailsRatherThanDropASequence checks that a sequence folder the
// build cannot read stops the build, while a folder that is not a sequence
// folder at all is skipped.
func TestBuildFailsRatherThanDropASequence(t *testing.T) {
	orig, err := loadGAFSequences(encode(t, testSequences()))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	pal := testPalette(t)
	if _, err := dumpSequences(orig, pal, dir, dumpOptions{Format: "png"}); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	policy, err := parseStoragePolicy("auto", "fx.gaf")
	if err != nil {
		t.Fatal(err)
	}
	var skipped []string
	built, err := buildSequences(dir, pal, policy, func(d string, _ *gaf.Sequence, err error) {
		if errors.Is(err, errNotSequenceFolder) {
			skipped = append(skipped, d)
		}
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if len(built) != 2 || len(skipped) != 1 || skipped[0] != "notes" {
		t.Errorf("built %d sequences, skipped %v; want 2 and [notes]", len(built), skipped)
	}

	if err := os.Remove(filepath.Join(dir, "Spin", "1.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := buildSequences(dir, pal, policy, nil); err == nil || !strings.Contains(err.Error(), "Spin") {
		t.Errorf("build with a missing frame image: err = %v, want a failure naming Spin", err)
	}
}

// TestRoundtripRetailGAFs runs both roundtrip legs on retail files whose
// raw frames have uniform, non-key corners (logos, exp1, armcamo) and on
// files the game reads as plain pixel arrays (vismasks, textures).
func TestRoundtripRetailGAFs(t *testing.T) {
	pal := testPalette(t)
	for _, rel := range [][]string{
		{"anims", "logos.gaf"},
		{"anims", "exp1.gaf"},
		{"anims", "armcamo.gaf"},
		{"anims", "vismasks.gaf"},
		{"textures", "wreckage.gaf"},
	} {
		path := testutil.UnpackedFile(t, rel...)
		r := testOneGAF(path, pal, false)
		if !r.EncodeOK || !r.BuildOK {
			t.Errorf("%s: encode=%v (%s) build=%v (%s)", filepath.Join(rel...), r.EncodeOK, r.EncodeErr, r.BuildOK, r.BuildErr)
		}
	}
}
