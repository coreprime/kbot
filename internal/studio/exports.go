package studio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/tntpreview"
)

// Advanced › Export menu endpoints.  Each accepts a JSON saveRequest
// describing the editor's current state, materialises a tnt.Map via
// buildMap (the same pipeline save uses), then renders the requested
// PNG and streams it back as image/png.  Errors are bubbled as 4xx /
// 5xx text so the client can show them in setStatus().

// handleExportMapImage renders the bare tile grid at 32 px per tile —
// no feature sprites, no StartPos markers.  Equivalent to the CLI's
// `kbot tnt image` and the MCP `tnt_image` tool.  Output can be very
// large for big maps (a 256×256 tile map is 8192×8192 px); the client
// warns the user before hitting this.
func (sess *Session) handleExportMapImage(w http.ResponseWriter, r *http.Request) {
	m, _, _, ok := sess.buildMapFromExportRequestWithFeatures(w, r)
	if !ok {
		return
	}
	writePNGResponse(w, m.RenderTileMap(sess.loadVFSPalette()))
}

// handleExportFullRender renders the full preview — tile grid +
// composited feature sprites + numbered StartPos markers for the
// editor's active schema.  Equivalent to the CLI's `kbot tnt preview
// --schema <ActiveSchema>` and the MCP `tnt_preview` tool, with the
// generated OTA from buildOTA standing in for a sister .ota file.
func (sess *Session) handleExportFullRender(w http.ResponseWriter, r *http.Request) {
	m, features, req, ok := sess.buildMapFromExportRequestWithFeatures(w, r)
	if !ok {
		return
	}
	base := m.RenderTileMap(sess.loadVFSPalette())
	if sess.vfs == nil {
		// No VFS bound — degrade to the bare tile render rather than
		// 500ing.  The user still gets a useful image; sprites and
		// markers just won't be drawn.
		writePNGResponse(w, base)
		return
	}
	spritePal, palErr := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if palErr != nil {
		http.Error(w, fmt.Sprintf("load sprite palette: %v", palErr), http.StatusInternalServerError)
		return
	}
	otaText := buildOTA(req)
	if _, err := tntpreview.ComposeWith(
		base, m, features, sess.vfs, spritePal,
		req.MapName, otaText,
		tntpreview.Options{SchemaIndex: req.ActiveSchema},
	); err != nil {
		http.Error(w, fmt.Sprintf("compose preview: %v", err), http.StatusInternalServerError)
		return
	}
	writePNGResponse(w, base)
}

// handleExportBuildmap renders the per-cell buildability classification.
// See [tnt.Map.RenderBuildMap] for the colour key.
func (sess *Session) handleExportBuildmap(w http.ResponseWriter, r *http.Request) {
	m, _, _, ok := sess.buildMapFromExportRequestWithFeatures(w, r)
	if !ok {
		return
	}
	img := m.RenderBuildMap(m.Header.SeaLevel)
	if img == nil {
		http.Error(w, "map has no attribute grid", http.StatusInternalServerError)
		return
	}
	writePNGResponse(w, img)
}

// handleExportVoidmap renders the engine-void mask (0xFFFC cells only).
func (sess *Session) handleExportVoidmap(w http.ResponseWriter, r *http.Request) {
	m, _, _, ok := sess.buildMapFromExportRequestWithFeatures(w, r)
	if !ok {
		return
	}
	img := m.RenderVoidMap()
	if img == nil {
		http.Error(w, "map has no attribute grid", http.StatusInternalServerError)
		return
	}
	writePNGResponse(w, img)
}

// buildMapFromExportRequestWithFeatures decodes the saveRequest body,
// runs buildMap, and writes an appropriate HTTP error if anything
// fails.  Returns (map, features, req, true) on success; the third
// component is the parsed body so callers that need fields beyond the
// tnt.Map (the active schema index, the OTA, the map name, etc.) don't
// have to decode the JSON twice.
func (sess *Session) buildMapFromExportRequestWithFeatures(w http.ResponseWriter, r *http.Request) (*tnt.Map, []tnt.Feature, saveRequest, bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return nil, nil, saveRequest{}, false
	}
	if !sameOrigin(r) {
		http.Error(w, "cross-origin POST refused", http.StatusForbidden)
		return nil, nil, saveRequest{}, false
	}
	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return nil, nil, saveRequest{}, false
	}
	if req.TileW <= 0 || req.TileH <= 0 {
		http.Error(w, "tileW and tileH must be positive", http.StatusBadRequest)
		return nil, nil, saveRequest{}, false
	}
	m, features, err := sess.buildMap(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
		return nil, nil, saveRequest{}, false
	}
	return m, features, req, true
}

// writePNGResponse encodes img into the response body with the correct
// content headers.  Encoding into a buffer first means a partial PNG
// can't end up streamed to the client when encoding errors mid-write.
func writePNGResponse(w http.ResponseWriter, img image.Image) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		http.Error(w, fmt.Sprintf("encode png: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", buf.Len()))
	_, _ = w.Write(buf.Bytes())
}
