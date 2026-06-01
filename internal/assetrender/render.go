package assetrender

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"path"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/fnt"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pal"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tnt"
)

// RenderRequest captures the query options a representation URL can carry. The
// studio HTTP layer parses it from the request's query string; the cache-warmer
// builds it directly. Unset numeric selectors use -1 so "frame 0" stays
// distinct from "no frame".
type RenderRequest struct {
	Format       string // output encoding hint: png, gif, apng, jpg, bmp
	View         string // TNT/SCT view: tilemap, minimap, heightmap, buildmap, voidmap, ascii
	Sequence     int    // GAF sequence index (used when SequenceName is empty)
	SequenceName string // GAF sequence by name (wins over Sequence when set)
	Frame        int    // GAF frame index; -1 renders the whole sequence
	Text         string // FNT preview text (empty falls back to a pangram)
	Palette      string // palette override path (VFS-relative)
	Transparency string // GAF transparency mode or index
}

// IsRender reports whether req asks for a rendered representation rather than
// the raw bytes. The handler uses it to decide between Render and a plain
// passthrough.
func (req RenderRequest) IsRender() bool {
	return req.Format != "" || req.View != "" || req.Text != "" ||
		req.Sequence >= 0 || req.SequenceName != ""
}

// CacheTag is a short, stable digest of the request options. Folded into an
// HTTP ETag it ensures a palette/view/frame change yields a distinct validator
// so browsers don't serve a stale representation from a 304.
func (req RenderRequest) CacheTag() string {
	return paletteCacheSuffix(strings.Join([]string{
		req.Format, req.View, strconv.Itoa(req.Sequence), req.SequenceName,
		strconv.Itoa(req.Frame), req.Text, req.Palette, req.Transparency,
	}, "|"))
}

// Render produces a non-raw representation of the file at vpath. It dispatches
// on the file extension and caches the encoded result keyed to the file's
// content plus the request options, so palette/transparency/view changes each
// get their own entry.
func (r *Renderer) Render(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	switch strings.ToLower(path.Ext(vpath)) {
	case ".gaf":
		return r.renderGAF(vpath, data, req)
	case ".pcx":
		return r.renderPCX(vpath, data, req)
	case ".pal":
		return r.renderPAL(vpath, data)
	case ".fnt":
		return r.renderFNT(vpath, data, req)
	case ".tnt":
		return r.renderTNT(vpath, data, req)
	case ".sct":
		return r.renderSCT(vpath, data, req)
	default:
		if ext := strings.ToLower(path.Ext(vpath)); isVideoExt(ext) {
			return r.renderVideo(vpath, data, req)
		}
		return Rendered{}, fmt.Errorf("no image representation for %s", path.Ext(vpath))
	}
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (r *Renderer) renderGAF(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return Rendered{}, fmt.Errorf("parse GAF: %w", err)
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		return Rendered{}, fmt.Errorf("read sequences: %w", err)
	}

	seqIdx := req.Sequence
	if seqIdx < 0 {
		seqIdx = 0
	}
	if req.SequenceName != "" {
		seqIdx = -1
		for i, s := range sequences {
			if strings.EqualFold(s.Name, req.SequenceName) {
				seqIdx = i
				break
			}
		}
		if seqIdx < 0 {
			return Rendered{}, fmt.Errorf("sequence %q not found", req.SequenceName)
		}
	}
	if seqIdx >= len(sequences) {
		return Rendered{}, fmt.Errorf("sequence index %d out of range", seqIdx)
	}
	seq := sequences[seqIdx]

	palette, paletteTag := r.ResolvePalette(vpath, req.Palette)
	opts, transparencyTag := TransparencyFromQuery(req.Transparency)

	format := strings.ToLower(req.Format)
	key := r.CacheKey(vpath, data)
	suffix := fmt.Sprintf("-seq%d", seqIdx)

	// Whole-sequence animation when no specific frame is requested.
	if req.Frame < 0 {
		if format == "" {
			format = "apng"
		}
		ext := suffix + "-" + paletteCacheSuffix(paletteTag) + "-" + transparencyTag + "." + format
		switch format {
		case "gif":
			body, err := r.renderCached("gaf-gif", key, ext, func() ([]byte, error) {
				var buf bytes.Buffer
				if err := seq.WriteGIFWith(&buf, palette, opts); err != nil {
					return nil, err
				}
				return buf.Bytes(), nil
			})
			return Rendered{ContentType: "image/gif", Body: body}, err
		case "apng":
			body, err := r.renderCached("gaf-apng", key, ext, func() ([]byte, error) {
				var buf bytes.Buffer
				if err := seq.ToAPNGWith(palette, opts, &buf); err != nil {
					return nil, err
				}
				return buf.Bytes(), nil
			})
			return Rendered{ContentType: "image/apng", Body: body}, err
		default:
			return Rendered{}, fmt.Errorf("unsupported sequence format %q", format)
		}
	}

	if req.Frame >= len(seq.Frames) {
		return Rendered{}, fmt.Errorf("frame index %d out of range", req.Frame)
	}
	frame := seq.Frames[req.Frame]
	if format == "" {
		format = "png"
	}
	ext := fmt.Sprintf("%s-frame%d-%s-%s.%s", suffix, req.Frame, paletteCacheSuffix(paletteTag), transparencyTag, format)

	switch format {
	case "png":
		body, err := r.renderCached("gaf-png", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := frame.ToPNGWith(palette, opts, &buf); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/png", Body: body}, err
	case "jpg", "jpeg":
		body, err := r.renderCached("gaf-jpg", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, frame.ToImageWith(palette, opts), &jpeg.Options{Quality: 90}); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/jpeg", Body: body}, err
	case "gif":
		single := &gaf.Sequence{Name: seq.Name, Frames: []*gaf.Frame{frame}}
		body, err := r.renderCached("gaf-gif", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := single.WriteGIFWith(&buf, palette, opts); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/gif", Body: body}, err
	case "apng":
		single := &gaf.Sequence{Name: seq.Name, Frames: []*gaf.Frame{frame}}
		body, err := r.renderCached("gaf-apng", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := single.ToAPNGWith(palette, opts, &buf); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/apng", Body: body}, err
	default:
		return Rendered{}, fmt.Errorf("unsupported frame format %q", format)
	}
}

func (r *Renderer) renderPCX(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	format := strings.ToLower(req.Format)
	if format == "" {
		format = "png"
	}
	key := r.CacheKey(vpath, data)
	ext := "." + format

	switch format {
	case "png":
		body, err := r.renderCached("pcx-png", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := pcx.ConvertToPNG(&buf, bytes.NewReader(data)); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/png", Body: body}, err
	case "gif":
		body, err := r.renderCached("pcx-gif", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := pcx.ConvertToGIF(&buf, bytes.NewReader(data)); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/gif", Body: body}, err
	case "bmp":
		body, err := r.renderCached("pcx-bmp", key, ext, func() ([]byte, error) {
			var buf bytes.Buffer
			if err := pcx.ConvertToBMP(&buf, bytes.NewReader(data)); err != nil {
				return nil, err
			}
			return buf.Bytes(), nil
		})
		return Rendered{ContentType: "image/bmp", Body: body}, err
	default:
		return Rendered{}, fmt.Errorf("unsupported PCX format %q", format)
	}
}

func (r *Renderer) renderPAL(vpath string, data []byte) (Rendered, error) {
	body, err := r.renderCached("pal-png", r.CacheKey(vpath, data), ".swatch.png", func() ([]byte, error) {
		p, err := pal.LoadFromBytes(data)
		if err != nil {
			return nil, fmt.Errorf("parse palette: %w", err)
		}
		return encodePNG(p.RenderSwatch(16))
	})
	return Rendered{ContentType: "image/png", Body: body}, err
}

func (r *Renderer) renderFNT(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	fg := color.RGBA{220, 220, 220, 255}
	bg := color.RGBA{30, 30, 30, 255}
	key := r.CacheKey(vpath, data)

	if req.Text != "" {
		body, err := r.renderCached("fnt-text", key, "-"+paletteCacheSuffix(req.Text)+".png", func() ([]byte, error) {
			font, err := fnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return nil, fmt.Errorf("parse font: %w", err)
			}
			return encodePNG(font.RenderText(req.Text, fg, bg))
		})
		return Rendered{ContentType: "image/png", Body: body}, err
	}

	body, err := r.renderCached("fnt-sheet", key, ".sheet.png", func() ([]byte, error) {
		font, err := fnt.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("parse font: %w", err)
		}
		return encodePNG(font.RenderSheet(fg, bg))
	})
	return Rendered{ContentType: "image/png", Body: body}, err
}

func (r *Renderer) renderTNT(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	view := strings.ToLower(req.View)
	if view == "" {
		view = "minimap"
	}
	key := r.CacheKey(vpath, data)

	load := func() (*tnt.Map, error) { return tnt.LoadFromReader(bytes.NewReader(data)) }

	if view == "ascii" {
		body, err := r.renderCached("tnt-ascii", key, ".ascii.txt", func() ([]byte, error) {
			m, err := load()
			if err != nil {
				return nil, fmt.Errorf("parse TNT: %w", err)
			}
			return []byte(m.RenderASCII(128)), nil
		})
		return Rendered{ContentType: "text/plain; charset=utf-8", Body: body}, err
	}

	body, err := r.renderCached("tnt-png", key, "."+view+".png", func() ([]byte, error) {
		m, err := load()
		if err != nil {
			return nil, fmt.Errorf("parse TNT: %w", err)
		}
		img, err := renderTNTView(m, view, r.GlobalPalette())
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := tnt.WritePNG(&buf, img); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	})
	return Rendered{ContentType: "image/png", Body: body}, err
}

func renderTNTView(m *tnt.Map, view string, palette color.Palette) (image.Image, error) {
	switch view {
	case "tilemap":
		return m.RenderTileMap(palette), nil
	case "minimap":
		if img := m.RenderMinimap(palette); img != nil {
			return img, nil
		}
		return image.NewRGBA(image.Rect(0, 0, 1, 1)), nil
	case "heightmap":
		if img := m.RenderHeightMap(); img != nil {
			return img, nil
		}
		return image.NewGray(image.Rect(0, 0, 1, 1)), nil
	case "buildmap":
		return m.RenderBuildMap(m.Header.SeaLevel), nil
	case "voidmap":
		return m.RenderVoidMap(), nil
	default:
		return nil, fmt.Errorf("unsupported TNT view %q", view)
	}
}

func (r *Renderer) renderSCT(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	view := strings.ToLower(req.View)
	if view == "" {
		view = "minimap"
	}
	key := r.CacheKey(vpath, data)

	body, err := r.renderCached("sct-png", key, "."+view+".png", func() ([]byte, error) {
		s, err := sct.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("parse SCT: %w", err)
		}
		img, err := renderSCTView(s, view, r.GlobalPalette())
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := sct.WritePNG(&buf, img); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	})
	return Rendered{ContentType: "image/png", Body: body}, err
}

func renderSCTView(s *sct.Section, view string, palette color.Palette) (image.Image, error) {
	switch view {
	case "tilemap":
		return s.RenderTileMap(palette), nil
	case "minimap":
		if img := s.RenderMinimap(palette); img != nil {
			return img, nil
		}
		return image.NewRGBA(image.Rect(0, 0, 1, 1)), nil
	case "heightmap":
		if img := s.RenderHeightMap(); img != nil {
			return img, nil
		}
		return image.NewGray(image.Rect(0, 0, 1, 1)), nil
	default:
		return nil, fmt.Errorf("unsupported SCT view %q", view)
	}
}
