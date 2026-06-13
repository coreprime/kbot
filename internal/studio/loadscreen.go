package studio

import (
	"bytes"
	"net/http"
	"path"
	"strings"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pcx"
)

// Sandbox loading-screen art: both games ship a loading splash in their
// assets — TA's classic 640×480 "LOADING…" panel (bitmaps/loadgame2bg.pcx)
// and TA:Kingdoms' gothic archway / stained-glass medallion (anims/loading*
// .gaf). The sandbox launch overlay drapes the first one the session's VFS
// carries behind its progress bar, so the wait reads as the real game
// loading rather than a blank spinner. Rendered once per session and
// memoised — the art never changes for a given VFS.

// loadScreenCandidate is one art source, tried in order. kind selects the
// decoder; seq names the GAF sequence to prefer (its last frame renders the
// most complete image).
type loadScreenCandidate struct {
	vpath string
	kind  string // "pcx" or "gaf"
	seq   string
}

// loadScreenCandidates is the priority list: the game-specific full panels
// first, a shared fallback last. Probing by file presence keeps it
// game-agnostic — whichever the mounted VFS carries wins.
var loadScreenCandidates = []loadScreenCandidate{
	{"bitmaps/loadgame2bg.pcx", "pcx", ""},    // TA: full "LOADING…" screen
	{"anims/loading.gaf", "gaf", "Loading"},   // TA:K: stained-glass medallion
	{"anims/loadgame.gaf", "gaf", "LoadGame"}, // shared fallback
}

// handleSandboxLoadScreen serves the session game's loading-screen art as a
// PNG. 404 when the VFS carries none (the client then shows its own themed
// panel with no backdrop image).
func (sess *Session) handleSandboxLoadScreen(w http.ResponseWriter, _ *http.Request) {
	sess.loadScreenOnce.Do(func() { sess.loadScreenPNG = sess.renderLoadScreen() })
	if sess.loadScreenPNG == nil {
		http.Error(w, "no loading screen art", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(sess.loadScreenPNG)
}

// renderLoadScreen walks the candidate list and returns the first that
// decodes to PNG, or nil when none of the art files are present.
func (sess *Session) renderLoadScreen() []byte {
	if sess.vfs == nil {
		return nil
	}
	for _, c := range loadScreenCandidates {
		data, err := sess.vfs.ReadFile(c.vpath)
		if err != nil {
			continue
		}
		var png []byte
		switch c.kind {
		case "pcx":
			png = renderPCXScreen(data)
		case "gaf":
			png = sess.renderGAFScreen(data, c.vpath, c.seq)
		}
		if png != nil {
			return png
		}
	}
	return nil
}

// renderPCXScreen decodes a PCX (embedded palette) to PNG.
func renderPCXScreen(data []byte) []byte {
	var buf bytes.Buffer
	if err := pcx.ConvertToPNG(&buf, bytes.NewReader(data)); err != nil {
		return nil
	}
	return buf.Bytes()
}

// renderGAFScreen decodes a GAF's preferred sequence (by name, else the
// first) and renders its LAST frame — the most complete image in an
// animated build-up — through the game's palette.
func (sess *Session) renderGAFScreen(data []byte, vpath, seqName string) []byte {
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil || len(sequences) == 0 {
		return nil
	}
	target := sequences[0]
	for _, s := range sequences {
		if strings.EqualFold(s.Name, seqName) {
			target = s
			break
		}
	}
	if len(target.Frames) == 0 {
		return nil
	}
	// TA:K ships each loading GAF's palette in a sibling <stem>.pcx — a 1×1
	// palette-carrier file, not an image. Render the frame through it; using
	// the game's global/feature palette instead is what left the TA:K loading
	// splash mis-coloured and corrupted. Fall back to the feature palette when
	// no sibling PCX is present (TA's loadgame.gaf path).
	var pal *gaf.Palette
	pcxPath := strings.TrimSuffix(vpath, path.Ext(vpath)) + ".pcx"
	if pdata, perr := sess.vfs.ReadFile(pcxPath); perr == nil {
		if pr, rerr := pcx.LoadFromReader(bytes.NewReader(pdata)); rerr == nil && pr.HasEmbeddedPalette() {
			pal = pr.EmbeddedPalette()
		}
	}
	if pal == nil {
		name := strings.TrimSuffix(path.Base(strings.ToLower(vpath)), ".gaf")
		pal = sess.palettes().FeaturePalette(name)
	}
	var buf bytes.Buffer
	if err := target.Frames[len(target.Frames)-1].ToPNG(pal, &buf); err != nil {
		return nil
	}
	return buf.Bytes()
}
