package studio

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"strings"

	"github.com/coreprime/kbot/formats/objects3d"
)

// Spin-preview tuning for wreckage / object features.
const (
	objectSpinFrames  = 30
	objectSpinDelayMS = 90 // ~2.7s per full rotation
)

// objectMaterial backs objects3d.Material with the session's VFS: GAF textures
// (decoded + cached) for textured primitives and the palette for colour-keyed
// primitives. The 3DO rasteriser stays VFS-agnostic; this is the bridge that
// lets wreck/unit previews show real textures, mapped the same way the in-app
// 3D viewer maps them.
type objectMaterial struct {
	sess *Session
	pal  color.Palette
}

func (m *objectMaterial) PaletteColor(index int) (color.RGBA, bool) {
	if index >= 0 && index < len(m.pal) {
		r, g, b, _ := m.pal[index].RGBA()
		return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), 0xff}, true
	}
	return color.RGBA{}, false
}

func (m *objectMaterial) Texture(name string) (*image.RGBA, bool) {
	img := m.sess.objectTexture(name)
	return img, img != nil
}

// objectTexture resolves a 3DO texture name to a decoded RGBA image via the
// session's texture index, memoised (nil cached = unresolved).
func (sess *Session) objectTexture(name string) *image.RGBA {
	key := strings.ToLower(name)

	sess.objTexMu.Lock()
	if sess.objTex == nil {
		sess.objTex = map[string]*image.RGBA{}
	}
	if v, seen := sess.objTex[key]; seen {
		sess.objTexMu.Unlock()
		return v
	}
	sess.objTexMu.Unlock()

	var out *image.RGBA
	if src, ok := sess.ensureTextureIndex()[key]; ok {
		// Object previews have no requesting unit, so no side preference.
		if data, err := sess.renderTexturePNG(src, ""); err == nil {
			if dec, err := png.Decode(bytes.NewReader(data)); err == nil {
				out = toRGBAImage(dec)
			}
		}
	}
	sess.objTexMu.Lock()
	sess.objTex[key] = out
	sess.objTexMu.Unlock()
	return out
}

func toRGBAImage(src image.Image) *image.RGBA {
	if r, ok := src.(*image.RGBA); ok {
		return r
	}
	b := src.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, src, b.Min, draw.Src)
	return dst
}

// baseObjectOptions returns the default camera with the session's texture/palette
// material attached. The colour-keyed-primitive palette is chosen for `object`:
// for TA:Kingdoms that's the model's per-side texture palette, else the VFS
// global palette. (Textures themselves are resolved per-source-GAF inside the
// material's Texture method.)
func (sess *Session) baseObjectOptions(object string) objects3d.RenderOptions {
	opts := objects3d.DefaultRenderOptions()
	opts.Material = &objectMaterial{sess: sess, pal: sess.palettes().ModelColorPalette(object)}
	return opts
}

// objectStillOptions: the small list thumbnail — steep top-down at TRUE game
// scale so wrecks read at their real relative sizes.
func (sess *Session) objectStillOptions(object string) objects3d.RenderOptions {
	return sess.baseObjectOptions(object)
}

// objectSpinOptions: the large hover preview — a 3/4 turntable (so the spin reads
// as the model orbiting, not a top-down flatten) filling the (larger) frame so
// detail is visible.
func (sess *Session) objectSpinOptions(object string, size int) objects3d.RenderOptions {
	opts := sess.baseObjectOptions(object)
	opts.ElevationDeg = 32 // 3/4 view: clean turntable orbit
	opts.FitToFrame = true // fill the larger hover frame
	if size > 0 {
		opts.Width, opts.Height = size, size
	}
	return opts
}

func (sess *Session) loadObjectModel(object string) (*objects3d.Model, error) {
	if sess.vfs == nil {
		return nil, fmt.Errorf("no vfs mounted")
	}
	path := "objects3d/" + strings.ToLower(object) + ".3do"
	data, err := sess.vfs.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("3do not found: %s", path)
	}
	model, err := objects3d.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse 3do %s: %w", path, err)
	}
	return model, nil
}

// serveObjectFeaturePreview renders a feature's 3DO object and serves it:
// a still PNG when staticOnly, otherwise a slow 360° spin APNG (shown on hover
// in the features drawer). Memoised under cacheKey.
func (sess *Session) serveObjectFeaturePreview(w http.ResponseWriter, cacheKey, object string, staticOnly bool, size int) {
	model, err := sess.loadObjectModel(object)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	var b []byte
	if staticOnly {
		b, err = model.RenderPNG(sess.objectStillOptions(object))
	} else {
		b, err = model.RenderSpinAPNG(sess.objectSpinOptions(object, size), objectSpinFrames, objectSpinDelayMS)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	sess.featureCacheMu.Lock()
	sess.featureCache[cacheKey] = b
	sess.featureCacheMu.Unlock()
	w.Header().Set("Content-Type", contentTypeForFeature(staticOnly))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(b)
}
