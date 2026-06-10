package studio

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"strings"

	"github.com/coreprime/kbot/formats/tnt"
)

// TA:Kingdoms terrain is not a tile-grid like TA — it is a texture-mapped
// surface: each graphic unit indexes into one of the map's terrain JPGs
// (terrain/<hex>.jpg) at a (u,v) offset. RenderTAKTerrain composites the full
// surface given a texture provider; this file wires that to the session VFS and
// serves a downscaled PNG used as the welcome background today (and the editor
// world backdrop in the terrain-editing phase).

// takTerrainProvider resolves a TA:K terrain texture name to its decoded JPG
// from the session VFS. A missing/undecodable texture yields nil so that unit
// renders blank rather than aborting the whole map.
func (sess *Session) takTerrainProvider() func(name uint32) image.Image {
	return func(name uint32) image.Image {
		data, err := sess.vfs.ReadFile(fmt.Sprintf("terrain/%08x.jpg", name))
		if err != nil {
			return nil
		}
		img, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil {
			return nil
		}
		return img
	}
}

// renderTAKTerrain composites the full TA:K terrain surface for a map, or
// returns nil with an error when the map isn't a TA:K texture-mapped map or has
// no terrain table.
func (sess *Session) renderTAKTerrain(mapPath string) (*image.RGBA, error) {
	data, err := sess.vfs.ReadFile(mapPath)
	if err != nil {
		return nil, err
	}
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	img := m.RenderTAKTerrain(sess.takTerrainProvider())
	if img == nil {
		return nil, fmt.Errorf("map %s has no TA:K terrain", mapPath)
	}
	return img, nil
}

// downscaleRGBA box-averages src down so its longest side is at most maxDim,
// returning src unchanged when it's already within bounds. Pure Go (no extra
// image deps); a box filter is plenty for decorative backgrounds.
func downscaleRGBA(src *image.RGBA, maxDim int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= maxDim && sh <= maxDim {
		return src
	}
	scale := float64(maxDim) / float64(sw)
	if sh > sw {
		scale = float64(maxDim) / float64(sh)
	}
	dw := int(float64(sw) * scale)
	dh := int(float64(sh) * scale)
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for dy := 0; dy < dh; dy++ {
		sy0 := b.Min.Y + dy*sh/dh
		sy1 := b.Min.Y + (dy+1)*sh/dh
		if sy1 <= sy0 {
			sy1 = sy0 + 1
		}
		for dx := 0; dx < dw; dx++ {
			sx0 := b.Min.X + dx*sw/dw
			sx1 := b.Min.X + (dx+1)*sw/dw
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			var rs, gs, bs, count uint32
			for yy := sy0; yy < sy1; yy++ {
				row := (yy-b.Min.Y)*src.Stride + (sx0-b.Min.X)*4
				for xx := sx0; xx < sx1; xx++ {
					rs += uint32(src.Pix[row])
					gs += uint32(src.Pix[row+1])
					bs += uint32(src.Pix[row+2])
					count++
					row += 4
				}
			}
			if count == 0 {
				count = 1
			}
			o := dst.PixOffset(dx, dy)
			dst.Pix[o] = uint8(rs / count)
			dst.Pix[o+1] = uint8(gs / count)
			dst.Pix[o+2] = uint8(bs / count)
			dst.Pix[o+3] = 0xff
		}
	}
	return dst
}

// handleMapRender serves a downscaled PNG of a TA:K map's full terrain surface
// (crisp, correctly-palettised — unlike the 126px baked minimap), used for the
// welcome background slideshow. Memoised per map path.
func (sess *Session) handleMapRender(w http.ResponseWriter, r *http.Request) {
	mapPath := strings.TrimPrefix(r.URL.Path, "/api/studio/map-render/")
	if mapPath == "" {
		http.Error(w, "missing map path", http.StatusBadRequest)
		return
	}
	sess.takTerrainMu.Lock()
	if sess.takTerrainPNG == nil {
		sess.takTerrainPNG = map[string][]byte{}
	}
	cached, ok := sess.takTerrainPNG[mapPath]
	sess.takTerrainMu.Unlock()
	if ok {
		if cached == nil {
			http.Error(w, "no terrain", http.StatusNotFound)
			return
		}
		writePNGBytes(w, cached)
		return
	}

	var out []byte
	if img, err := sess.renderTAKTerrain(mapPath); err == nil && img != nil {
		// TA:Kingdoms texture-mapped terrain: crisp full-resolution render.
		var buf bytes.Buffer
		if encErr := png.Encode(&buf, downscaleRGBA(img, 1100)); encErr == nil {
			out = buf.Bytes()
		}
	} else if data, err := sess.vfs.ReadFile(mapPath); err == nil {
		// Plain TNT (TA-style): fall back to the baked minimap.
		if m, err := tnt.LoadFromReader(bytes.NewReader(data)); err == nil && m.Minimap != nil {
			if mm := m.RenderMinimap(sess.palettes().terrainPalette(mapPath)); mm != nil {
				var buf bytes.Buffer
				if encErr := png.Encode(&buf, mm); encErr == nil {
					out = buf.Bytes()
				}
			}
		}
	}
	sess.takTerrainMu.Lock()
	sess.takTerrainPNG[mapPath] = out
	sess.takTerrainMu.Unlock()
	if out == nil {
		http.Error(w, "no terrain", http.StatusNotFound)
		return
	}
	writePNGBytes(w, out)
}

func writePNGBytes(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(b)
}
