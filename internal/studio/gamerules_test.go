package studio

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gaf"
)

// looseSession mounts files (VFS path → bytes) as a loose tree and returns a
// session over it for the given game id.
func looseSession(t *testing.T, game string, files map[string][]byte) *Session {
	t.Helper()
	base := t.TempDir()
	for rel, data := range files {
		full := filepath.Join(base, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	vfs, err := filesystem.NewVirtualFileSystem(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	sess := newSession("test", "test", vfs, t.TempDir())
	sess.game = game
	return sess
}

func gafBytes(t *testing.T, seqs ...*gaf.Sequence) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := gaf.WriteGAF(&buf, seqs); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// apngTiming reads num_plays from a PNG's acTL chunk (-1 when the file is
// not animated) and each frame's delay as a numerator/denominator pair.
func apngTiming(t *testing.T, data []byte) (plays int, delays [][2]uint16) {
	t.Helper()
	plays = -1
	if len(data) < 8 {
		t.Fatal("not a PNG")
	}
	for p := 8; p+8 <= len(data); {
		n := int(binary.BigEndian.Uint32(data[p:]))
		typ := string(data[p+4 : p+8])
		body := data[p+8 : p+8+n]
		switch typ {
		case "acTL":
			plays = int(binary.BigEndian.Uint32(body[4:]))
		case "fcTL":
			delays = append(delays, [2]uint16{binary.BigEndian.Uint16(body[20:]), binary.BigEndian.Uint16(body[22:])})
		}
		p += 12 + n
	}
	return plays, delays
}

func TestSpriteRenderOptionsFollowGame(t *testing.T) {
	ta := looseSession(t, "totala", nil)
	if m := ta.spriteRenderOptions().Mode; m != gaf.TransparencyModeMetadata {
		t.Errorf("TA sprites use mode %d, want the game's rule (metadata)", m)
	}
	unknown := looseSession(t, "", nil)
	if m := unknown.spriteRenderOptions().Mode; m != gaf.TransparencyModeMetadata {
		t.Errorf("an unknown game uses mode %d, want TA's rule", m)
	}
	tak := looseSession(t, "takingdoms", nil)
	if m := tak.spriteRenderOptions().Mode; m != gaf.TransparencyModeHeuristic {
		t.Errorf("TA: Kingdoms sprites use mode %d, want the corner guess", m)
	}
}

// TestFeatureAnimationFollowsLoopByteAndTicks checks the map editor's
// feature animations: frame delays are the game's ticks/30 s (at least one
// tick) and a sequence whose loop byte is 0 plays once.
func TestFeatureAnimationFollowsLoopByteAndTicks(t *testing.T) {
	frames := []*gaf.Frame{
		{Width: 2, Height: 1, TransparencyIndex: 9, Duration: 2, Storage: gaf.StorageRaw, Pixels: []byte{0, 9}},
		{Width: 2, Height: 1, TransparencyIndex: 9, Duration: 0, Storage: gaf.StorageRaw, Pixels: []byte{9, 0}},
	}
	once := &gaf.Sequence{Name: "burn", Frames: frames}
	loop := &gaf.Sequence{Name: "sway", Frames: frames, LoopFlags: 1}
	sess := looseSession(t, "totala", map[string][]byte{"anims/fx.gaf": gafBytes(t, once, loop)})

	data, err := sess.renderFeatureAPNG("fx", "burn")
	if err != nil {
		t.Fatal(err)
	}
	plays, delays := apngTiming(t, data)
	if plays != 1 {
		t.Errorf("loop byte 0: num_plays = %d, want 1 (play once)", plays)
	}
	if len(delays) != 2 || delays[0] != [2]uint16{2, 30} || delays[1] != [2]uint16{1, 30} {
		t.Errorf("frame delays = %v, want [2/30 1/30]", delays)
	}

	data, err = sess.renderFeatureAPNG("fx", "sway")
	if err != nil {
		t.Fatal(err)
	}
	if plays, _ := apngTiming(t, data); plays != 0 {
		t.Errorf("looping sequence: num_plays = %d, want 0 (forever)", plays)
	}
}

// TestFeatureStillKeepsBlackAndCorners checks the feature drawer's still:
// palette index 0 is opaque black, the key is transparent, and a frame
// whose corners share a colour keeps them.
func TestFeatureStillKeepsBlackAndCorners(t *testing.T) {
	seq := &gaf.Sequence{Name: "rock", LoopFlags: 1, Frames: []*gaf.Frame{{
		Width: 3, Height: 2, TransparencyIndex: 9, Duration: 1, Storage: gaf.StorageRaw,
		Pixels: []byte{79, 0, 79, 79, 9, 79},
	}}}
	sess := looseSession(t, "totala", map[string][]byte{"anims/rocks.gaf": gafBytes(t, seq)})
	data, err := sess.renderFeatureStaticPNG("rocks", "rock")
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range [][2]int{{0, 0}, {1, 0}, {2, 1}} {
		if _, _, _, a := img.At(p[0], p[1]).RGBA(); a != 0xffff {
			t.Errorf("pixel %v is transparent; the game draws it", p)
		}
	}
	if r, g, b, _ := img.At(1, 0).RGBA(); r|g|b != 0 {
		t.Errorf("index 0 pixel is not black")
	}
	if _, _, _, a := img.At(1, 1).RGBA(); a != 0 {
		t.Errorf("key pixel is drawn")
	}
}

// TestCursorKeepsCornerColours checks that cursors are drawn with the game's
// rule rather than a corner guess.
func TestCursorKeepsCornerColours(t *testing.T) {
	sess := looseSession(t, "totala", nil)
	seq := &gaf.Sequence{Name: "cursorrepair", LoopFlags: 1, Frames: []*gaf.Frame{{
		Width: 2, Height: 2, TransparencyIndex: 9, Duration: 1, Storage: gaf.StorageRaw,
		Pixels: []byte{79, 79, 79, 79},
	}}}
	data, err := sess.encodeCursorSequencePNG(seq)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(0, 0).RGBA(); a != 0xffff {
		t.Error("corner colour 79 became transparent")
	}
}

// TestTexturePNGKeepsIndexZeroOpaque checks unit textures for TA: every
// texel is drawn, palette index 0 included.
func TestTexturePNGKeepsIndexZeroOpaque(t *testing.T) {
	seq := &gaf.Sequence{Name: "plate", LoopFlags: 1, Frames: []*gaf.Frame{{
		Width: 2, Height: 1, TransparencyIndex: 9, Storage: gaf.StorageRaw, Pixels: []byte{0, 9},
	}}}
	sess := looseSession(t, "totala", map[string][]byte{"textures/plates.gaf": gafBytes(t, seq)})
	data, err := sess.renderTexturePNGFrame(textureSource{GAFPath: "textures/plates.gaf", SeqName: "plate"}, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	for x := 0; x < 2; x++ {
		if _, _, _, a := img.At(x, 0).RGBA(); a != 0xffff {
			t.Errorf("texel %d is transparent; TA samples textures without a key", x)
		}
	}
}

// TestExplorerDefaultTransparencyFollowsGame checks the asset explorer's
// default GAF render: TA frames keep a uniform border (the game uses the
// stored key only), TA: Kingdoms raw atlases get the corner guess.
func TestExplorerDefaultTransparencyFollowsGame(t *testing.T) {
	seq := &gaf.Sequence{Name: "atlas", LoopFlags: 1, Frames: []*gaf.Frame{{
		Width: 3, Height: 3, TransparencyIndex: 9, Duration: 1, Storage: gaf.StorageRaw,
		Pixels: []byte{5, 5, 5, 5, 40, 5, 5, 5, 5},
	}}}
	files := map[string][]byte{"anims/atlas.gaf": gafBytes(t, seq)}
	for _, tc := range []struct {
		game       string
		cornerSeen bool
	}{{"totala", true}, {"takingdoms", false}} {
		sess := looseSession(t, tc.game, files)
		rec := doVFS(t, sess, "/api/vfs/anims/atlas.gaf?format=png&sequence=0&frame=0")
		if rec.Code != 200 {
			t.Fatalf("%s: status %d: %s", tc.game, rec.Code, rec.Body.String())
		}
		img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, a := img.At(0, 0).RGBA()
		if (a == 0xffff) != tc.cornerSeen {
			t.Errorf("%s: corner alpha %d, want drawn=%v", tc.game, a, tc.cornerSeen)
		}
	}
}
