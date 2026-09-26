package fnt

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeFont builds a font of the given height, baseline and first character
// code whose glyphs (code → width) have every pixel set.
func makeFont(height int, baseline int8, glyphs map[byte]int) []byte {
	head := []byte{byte(height), 0, byte(baseline), 0}
	offsets := make([]byte, 512)
	var data []byte
	for code := 0; code < 256; code++ {
		w, ok := glyphs[byte(code)]
		if !ok {
			continue
		}
		binary.LittleEndian.PutUint16(offsets[2*code:], uint16(516+len(data)))
		data = append(data, byte(w))
		data = append(data, bytes.Repeat([]byte{0xFF}, (w*height+7)/8)...)
	}
	return append(append(head, offsets...), data...)
}

func writeFont(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "test.fnt")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func() error) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	runErr := fn()
	os.Stdout = orig
	_ = w.Close()
	out, _ := io.ReadAll(r)
	if runErr != nil {
		t.Fatal(runErr)
	}
	return string(out)
}

func renderWidth(t *testing.T, font string, args ...string) int {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out.png")
	cmd := newFNTRenderCommand()
	cmd.SetArgs(append([]string{font, "--target", out}, args...))
	cmd.SilenceUsage = true
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	cfg, err := png.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width
}

// TestRenderUsesTheGameLayout: a 13-row font with a 10-pixel 'A' and no
// space glyph draws "A A" 20 pixels wide in the game: each glyph advances
// by its width, a missing glyph adds nothing, there is no spacing.
func TestRenderUsesTheGameLayout(t *testing.T) {
	font := writeFont(t, makeFont(13, 2, map[byte]int{'A': 10, 0x80: 7, 0xAC: 3}))
	if w := renderWidth(t, font, "--text", "A A"); w != 20 {
		t.Errorf(`"A A" is %d px wide, want 20`, w)
	}
	// Drawing stops at the first newline.
	if w := renderWidth(t, font, "--text", "A\nAAA"); w != 10 {
		t.Errorf(`"A\nAAA" is %d px wide, want 10`, w)
	}
	// '€' is byte 0x80 in Windows-1252, not U+20AC mod 256 (0xAC).
	if w := renderWidth(t, font, "--text", "€"); w != 7 {
		t.Errorf(`"€" is %d px wide, want the 7-px glyph 0x80`, w)
	}
	// raw passes the UTF-8 bytes through: E2 82 AC, of which only 0xAC has a glyph.
	if w := renderWidth(t, font, "--text", "€", "--codepage", "raw"); w != 3 {
		t.Errorf(`raw "€" is %d px wide, want 3`, w)
	}
}

func TestDescribeAndInfoShowBaselineAndFirstChar(t *testing.T) {
	font := writeFont(t, makeFont(13, 2, map[byte]int{'A': 10}))
	out := captureStdout(t, func() error {
		cmd := newFNTDescribeCommand()
		cmd.SetArgs([]string{font})
		return cmd.Execute()
	})
	for _, want := range []string{"Height:        13 px", "Baseline:      2", "First char:    0x00"} {
		if !strings.Contains(out, want) {
			t.Errorf("describe output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Flags") {
		t.Errorf("describe still prints Flags:\n%s", out)
	}
	out = captureStdout(t, func() error {
		cmd := newFNTInfoCommand()
		cmd.SetArgs([]string{font})
		return cmd.Execute()
	})
	if !strings.Contains(out, "height=13  baseline=2  first=0x00  glyphs=1") {
		t.Errorf("info output: %s", out)
	}
}
