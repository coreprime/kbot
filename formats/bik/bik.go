// Package bik reads RAD Game Tools Bink (.bik) video headers — the cutscene
// format TA: Kingdoms uses in place of the Smacker (.zrb) videos shipped with
// the original Total Annihilation.
//
// Like the smacker package, this reader parses the container header natively
// (geometry, frame counts, frame rate, audio tracks) but does not decode the
// compressed video bitstream: Bink uses a proprietary DCT-based codec with no
// open-source encoder.  Pixel decoding and conversion are delegated to FFmpeg,
// which ships a Bink 1 decoder (binkvideo + binkaudio_dct/rdft).  Because no
// Bink encoder exists outside RAD's own tools, conversion is decode-only — the
// reverse of smacker.ConvertFromMP4 is intentionally absent.
package bik

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// HeaderMinSize is the smallest valid Bink header (no audio tracks): the
// 44-byte fixed prefix up to and including the audio-track count.
const HeaderMinSize = 44

// maxAudioTracks guards against a corrupt track count driving a huge
// allocation.  Bink supports far fewer in practice; FFmpeg caps at 256.
const maxAudioTracks = 256

// maxFrames guards against a corrupt frame count.  FFmpeg applies the same
// sanity limit before trusting the per-frame index table.
const maxFrames = 1 << 20

// Audio-track flag bits (the 16-bit flags word per track).
const (
	audFlag16Bits = 0x4000 // 16-bit samples (else 8-bit)
	audFlagStereo = 0x2000 // stereo (else mono)
	audFlagUseDCT = 0x1000 // DCT codec (else RDFT)
)

// Video flag bits (the 32-bit video flags word).
const (
	vidFlagAlpha     = 0x00100000 // frames carry an alpha plane
	vidFlagGrayscale = 0x00020000 // luma-only frames
)

// AudioTrack describes one Bink audio stream.
type AudioTrack struct {
	SampleRate int    // samples per second
	Channels   int    // 1 (mono) or 2 (stereo)
	Bits       int    // 8 or 16
	Codec      string // "DCT" or "RDFT"
	ID         uint32 // track identifier from the trailing ID table
}

// Header holds the parsed fields of a Bink container header.
type Header struct {
	Revision     byte // the 4th signature byte: 'b','d','f','g','h','i','k', …
	FileSize     uint32
	Frames       uint32
	LargestFrame uint32
	Width        uint32
	Height       uint32
	FPSNum       uint32
	FPSDen       uint32
	VideoFlags   uint32
	AudioTracks  []AudioTrack
}

// Reader wraps an open Bink file and its parsed header.
type Reader struct {
	file   *os.File
	header *Header
}

// OpenReader opens a Bink video file and parses its header.
func OpenReader(path string) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open file: %w", err)
	}
	header, err := ReadHeader(f)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("failed to read header: %w", err)
	}
	return &Reader{file: f, header: header}, nil
}

// Close releases the underlying file handle.
func (r *Reader) Close() error {
	if r.file != nil {
		return r.file.Close()
	}
	return nil
}

// Header returns the parsed header.
func (r *Reader) Header() *Header { return r.header }

// Width returns the video width in pixels.
func (r *Reader) Width() int { return int(r.header.Width) }

// Height returns the video height in pixels.
func (r *Reader) Height() int { return int(r.header.Height) }

// FrameCount returns the number of video frames.
func (r *Reader) FrameCount() int { return int(r.header.Frames) }

// FrameRate returns the frame rate in frames per second.  Bink stores the
// rate as a numerator/denominator pair, so the result can be fractional.
func (r *Reader) FrameRate() float64 {
	if r.header.FPSDen == 0 {
		return 0
	}
	return float64(r.header.FPSNum) / float64(r.header.FPSDen)
}

// Duration returns the playback length in seconds.
func (r *Reader) Duration() float64 {
	fps := r.FrameRate()
	if fps == 0 {
		return 0
	}
	return float64(r.header.Frames) / fps
}

// HasAudio reports whether the file carries at least one audio track.
func (r *Reader) HasAudio() bool { return len(r.header.AudioTracks) > 0 }

// HasAlpha reports whether frames carry an alpha plane.
func (r *Reader) HasAlpha() bool { return r.header.VideoFlags&vidFlagAlpha != 0 }

// IsGrayscale reports whether frames are luma-only.
func (r *Reader) IsGrayscale() bool { return r.header.VideoFlags&vidFlagGrayscale != 0 }

// Version returns a human-readable codec/revision label.
func (r *Reader) Version() string {
	return fmt.Sprintf("Bink 1 (revision '%c')", r.header.Revision)
}

// ReadHeader parses a Bink header from r.  It reads only as far as the audio
// track tables; the per-frame index and the compressed bitstream are left
// untouched.
func ReadHeader(r io.Reader) (*Header, error) {
	var sig [4]byte
	if _, err := io.ReadFull(r, sig[:]); err != nil {
		return nil, fmt.Errorf("read signature: %w", err)
	}
	if string(sig[:3]) == "KB2" {
		return nil, fmt.Errorf("unsupported Bink 2 (KB2) file; only Bink 1 (BIK*) is supported")
	}
	if string(sig[:3]) != "BIK" {
		return nil, fmt.Errorf("invalid signature %q (expected BIK*)", string(sig[:]))
	}

	read32 := func(name string) (uint32, error) {
		var v uint32
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			return 0, fmt.Errorf("read %s: %w", name, err)
		}
		return v, nil
	}

	h := &Header{Revision: sig[3]}

	fileSizeMinus8, err := read32("file size")
	if err != nil {
		return nil, err
	}
	h.FileSize = fileSizeMinus8 + 8

	if h.Frames, err = read32("frame count"); err != nil {
		return nil, err
	}
	if h.Frames == 0 || h.Frames > maxFrames {
		return nil, fmt.Errorf("implausible frame count %d", h.Frames)
	}
	if h.LargestFrame, err = read32("largest frame size"); err != nil {
		return nil, err
	}
	if h.LargestFrame > h.FileSize {
		return nil, fmt.Errorf("largest frame size %d exceeds file size %d", h.LargestFrame, h.FileSize)
	}
	if _, err = read32("frame count copy"); err != nil { // duplicate frame count, unused
		return nil, err
	}
	if h.Width, err = read32("width"); err != nil {
		return nil, err
	}
	if h.Height, err = read32("height"); err != nil {
		return nil, err
	}
	if h.Width == 0 || h.Height == 0 || h.Width > 0x8000 || h.Height > 0x8000 {
		return nil, fmt.Errorf("implausible dimensions %dx%d", h.Width, h.Height)
	}
	if h.FPSNum, err = read32("fps numerator"); err != nil {
		return nil, err
	}
	if h.FPSDen, err = read32("fps denominator"); err != nil {
		return nil, err
	}
	if h.VideoFlags, err = read32("video flags"); err != nil {
		return nil, err
	}

	numTracks, err := read32("audio track count")
	if err != nil {
		return nil, err
	}
	if numTracks > maxAudioTracks {
		return nil, fmt.Errorf("implausible audio track count %d", numTracks)
	}
	if numTracks == 0 {
		return h, nil
	}

	// A per-track uint32 (max decoded packet size) precedes the track info;
	// FFmpeg skips it and so do we.
	if _, err := io.CopyN(io.Discard, r, int64(4*numTracks)); err != nil {
		return nil, fmt.Errorf("skip audio sizes: %w", err)
	}

	h.AudioTracks = make([]AudioTrack, numTracks)
	for i := range h.AudioTracks {
		var sampleRate, flags uint16
		if err := binary.Read(r, binary.LittleEndian, &sampleRate); err != nil {
			return nil, fmt.Errorf("read audio sample rate: %w", err)
		}
		if err := binary.Read(r, binary.LittleEndian, &flags); err != nil {
			return nil, fmt.Errorf("read audio flags: %w", err)
		}
		t := AudioTrack{SampleRate: int(sampleRate), Channels: 1, Bits: 8, Codec: "RDFT"}
		if flags&audFlagStereo != 0 {
			t.Channels = 2
		}
		if flags&audFlag16Bits != 0 {
			t.Bits = 16
		}
		if flags&audFlagUseDCT != 0 {
			t.Codec = "DCT"
		}
		h.AudioTracks[i] = t
	}
	for i := range h.AudioTracks {
		id, err := read32("audio track id")
		if err != nil {
			return nil, err
		}
		h.AudioTracks[i].ID = id
	}

	return h, nil
}

// Info returns a formatted multi-line summary of the header.
func (r *Reader) Info() string {
	h := r.header
	info := "Bink Video File\n"
	info += fmt.Sprintf("  Version: %s\n", r.Version())
	info += fmt.Sprintf("  Resolution: %dx%d\n", r.Width(), r.Height())
	info += fmt.Sprintf("  Frames: %d\n", r.FrameCount())
	info += fmt.Sprintf("  Frame Rate: %.2f fps\n", r.FrameRate())
	info += fmt.Sprintf("  Duration: %.2f seconds\n", r.Duration())
	info += fmt.Sprintf("  Alpha: %v\n", r.HasAlpha())
	info += fmt.Sprintf("  Grayscale: %v\n", r.IsGrayscale())
	info += fmt.Sprintf("  Has Audio: %v\n", r.HasAudio())
	for i, t := range h.AudioTracks {
		info += fmt.Sprintf("    Track %d: %d Hz, %d-bit, %d channel(s), %s\n",
			i, t.SampleRate, t.Bits, t.Channels, t.Codec)
	}
	return info
}
