package studio

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/url"
	"strings"

	"github.com/coreprime/kbot-io/formats/gaf"
)

// weapon_bitmap.go
//
// /api/studio/weapon-bitmap/{weapon} — serves the projectile sprite
// strip for a `rendertype=4` (BITMAP) weapon as a horizontal sprite
// sheet (PNG) + frame metadata (JSON).
//
// ============================== THE HACK ==============================
//
// In TA's stock data, `rendertype=4` weapons mean "the projectile is a
// 2D bitmap sprite from anims/fx.gaf."  The TDF `color=` field, which
// is normally a palette tint index (for lasers etc.), is REPURPOSED on
// rendertype=4 weapons as a small enum picking which fx.gaf sequence
// to render as the projectile body.  This is openly acknowledged in
// the stock TDF itself — the EMG weapon has the immortal comment:
//
//     color=2;    /* EMG bitmap shell, its a hack */
//
// (See weapons/weapons.tdf, [EMG] section.)  We faithfully reproduce
// the hack so the Peewee's chunky yellow EMG tracer, the Flak Cannon's
// little plasma puff, etc., look right.
//
// Empirically (256-weapon audit of stock TA 3.1c):
//
//   color=0 / unset → cannonshell  (regular cannon shot - 71 weapons)
//   color=1         → PlasmaSm     (small yellow plasma - 9 weapons)
//   color=2         → PlasmaMd     (medium plasma, the EMG sprite - 1)
//   color=255       → no art       (EARTHQUAKE: `// (No art)`)
//
// Mod weapons may use higher slot indices to reach the other sprites
// shipped in fx.gaf (ultrashell, blueshot, redshot, flamestream,
// parablast).  We map those linearly; if a mod author was clever
// enough to use a high slot, they get a defensible mapping.
// ======================================================================
//
// Endpoint behavior:
//   - returns JSON {sheet:<base64 PNG>, frameCount, frameWidth,
//     frameHeight, frameDurationMs, originX, originY}
//   - 404 when:
//       * the weapon name doesn't resolve to a known TDF section,
//       * its rendertype isn't 4,
//       * its color slot maps to "no art" (255 sentinel), or
//       * the fx.gaf sequence isn't in the VFS.
//   - caches hits + known-misses indefinitely (the sprite art is
//     immutable for the lifetime of the server process).

// colorSlotToFxSequence maps the rendertype=4 `color=` field to its
// fx.gaf sequence name.  Empty string means "no art shipped" (the
// 255-slot EARTHQUAKE case — the engine plays no projectile sprite,
// the weapon is invisible mid-flight and lets its impact carry the
// visual).
var colorSlotToFxSequence = map[int]string{
	0: "cannonshell",
	1: "PlasmaSm",
	2: "PlasmaMd",
	// Slots 3-7: best-guess linear walk through the remaining fx.gaf
	// projectile sequences.  Stock TA never uses these, but a mod
	// author who set color=3 likely meant "the next sprite over."
	3: "ultrashell",
	4: "blueshot",
	5: "redshot",
	6: "flamestream",
	7: "parablast",
}

// weaponBitmapResponse is the JSON shape the client gets.  All metadata
// the GL renderer needs to set up animated UV sampling lives here so
// the client doesn't have to parse the PNG itself.
type weaponBitmapResponse struct {
	Sheet           string `json:"sheet"`           // base64-encoded PNG of the horizontal sprite strip
	FrameCount      int    `json:"frameCount"`      // total frames in the strip
	FrameWidth      int    `json:"frameWidth"`      // one frame's pixel width
	FrameHeight     int    `json:"frameHeight"`     // one frame's pixel height
	SheetWidth      int    `json:"sheetWidth"`      // frameWidth * frameCount
	SheetHeight     int    `json:"sheetHeight"`     // = frameHeight
	FrameDurationMs int    `json:"frameDurationMs"` // average per-frame duration
	OriginX         int    `json:"originX"`         // hotspot within each frame, X
	OriginY         int    `json:"originY"`         // hotspot within each frame, Y
	Sequence        string `json:"sequence"`        // diagnostic: the fx.gaf sequence name
}

func (sess *Session) handleWeaponBitmap(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/studio/weapon-bitmap/")
	if rest == "" {
		http.Error(w, "missing weapon name", http.StatusBadRequest)
		return
	}
	name, err := url.PathUnescape(rest)
	if err != nil || name == "" {
		http.Error(w, "bad weapon name", http.StatusBadRequest)
		return
	}
	key := strings.ToUpper(strings.TrimSpace(name))

	sess.weaponBitmapMu.Lock()
	if cached, ok := sess.weaponBitmapCache[key]; ok {
		sess.weaponBitmapMu.Unlock()
		if len(cached) == 0 {
			http.Error(w, "weapon has no bitmap projectile", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	sess.weaponBitmapMu.Unlock()

	body, err := sess.buildWeaponBitmapJSON(name)
	if err != nil {
		sess._cacheWeaponBitmapMiss(key)
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	sess.weaponBitmapMu.Lock()
	sess.weaponBitmapCache[key] = body
	sess.weaponBitmapMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(body)
}

// buildWeaponBitmapJSON resolves a weapon name to its rendertype=4 sprite
// strip and returns the marshalled weaponBitmapResponse.  Shared by the
// live weapon-bitmap endpoint and the pack extractor; errors cover every
// "no bitmap projectile for this weapon" case.
func (sess *Session) buildWeaponBitmapJSON(name string) ([]byte, error) {
	sec := sess.loadWeaponSection(name)
	if sec == nil {
		return nil, fmt.Errorf("weapon not found")
	}
	if sec.RenderType != 4 {
		// Not a bitmap weapon — caller should be checking renderType
		// first, but a defensive error here keeps the contract clean.
		return nil, fmt.Errorf("weapon is not rendertype=4 bitmap")
	}
	colorSlot := sec.Color
	seqName, ok := colorSlotToFxSequence[colorSlot]
	if !ok || seqName == "" {
		return nil, fmt.Errorf("no fx.gaf sequence mapped for color=%d", colorSlot)
	}
	resp, err := sess.buildWeaponBitmapSheet(seqName)
	if err != nil {
		return nil, err
	}
	resp.Sequence = seqName
	body, err := json.Marshal(resp)
	if err != nil {
		return nil, fmt.Errorf("json encode failed")
	}
	return body, nil
}

// buildWeaponBitmapSheet reads anims/fx.gaf, locates the named
// sequence, and stitches every frame side-by-side into a single PNG
// strip.  Frames are normalized onto a common canvas sized to the
// bounding rect of all frames (using each frame's OriginX/Y as
// hotspot) so the projectile sprite's "centre" stays put as the
// animation cycles.
func (sess *Session) buildWeaponBitmapSheet(seqName string) (*weaponBitmapResponse, error) {
	data, err := sess.vfs.ReadFile("anims/fx.gaf")
	if err != nil {
		return nil, fmt.Errorf("fx.gaf not found")
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse fx.gaf: %w", err)
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil {
		return nil, fmt.Errorf("read sequences: %w", err)
	}
	var target *gaf.Sequence
	for _, s := range sequences {
		if strings.EqualFold(s.Name, seqName) {
			target = s
			break
		}
	}
	if target == nil {
		return nil, fmt.Errorf("sequence %q missing from fx.gaf", seqName)
	}
	if len(target.Frames) == 0 {
		return nil, fmt.Errorf("sequence %q has zero frames", seqName)
	}
	pal, err := gaf.LoadPaletteFromBytes(sess.loadPaletteBytes())
	if err != nil {
		return nil, fmt.Errorf("load palette: %w", err)
	}

	// Compute the common canvas size by union'ing every frame's
	// bounding rect (each frame extends from -OriginX..Width-OriginX in
	// X and -OriginY..Height-OriginY in Y).  Without this the sprite
	// would visibly jitter as the artist's per-frame origin shifted.
	var minX, minY, maxX, maxY int16 = 0, 0, 0, 0
	first := true
	totalDuration := uint32(0)
	for _, f := range target.Frames {
		if f.Width == 0 || f.Height == 0 {
			continue
		}
		left := -f.OriginX
		top := -f.OriginY
		right := int16(f.Width) - f.OriginX
		bottom := int16(f.Height) - f.OriginY
		if first {
			minX, minY, maxX, maxY = left, top, right, bottom
			first = false
		} else {
			if left < minX {
				minX = left
			}
			if top < minY {
				minY = top
			}
			if right > maxX {
				maxX = right
			}
			if bottom > maxY {
				maxY = bottom
			}
		}
		totalDuration += f.Duration
	}
	cw := int(maxX - minX)
	ch := int(maxY - minY)
	if cw <= 0 || ch <= 0 {
		return nil, fmt.Errorf("sequence %q has degenerate canvas", seqName)
	}
	// Hotspot within each cell — the "anchor" the renderer pins the
	// world-space projectile centre to.  Lives at where origin=(0,0)
	// would project on the common canvas.
	originX := int(-minX)
	originY := int(-minY)

	frameCount := len(target.Frames)
	sheet := image.NewRGBA(image.Rect(0, 0, cw*frameCount, ch))
	// Transparent background — the per-frame paste leaves cells outside
	// each glyph see-through so the additive blend doesn't paint a
	// black box around the sprite.
	draw.Draw(sheet, sheet.Bounds(), image.NewUniform(color.RGBA{0, 0, 0, 0}), image.Point{}, draw.Src)

	for i, f := range target.Frames {
		if f.Width == 0 || f.Height == 0 {
			continue
		}
		img := f.ToImage(pal)
		if img == nil {
			continue
		}
		// Position this frame's pixel buffer inside its cell so the
		// frame's origin lines up with the cell's hotspot.
		cellX := i * cw
		dstX := cellX + originX - int(f.OriginX)
		dstY := originY - int(f.OriginY)
		// image.Paletted carries its own colour model; draw.Over honours
		// transparency from the palette's RGBA entries (the transparency
		// index resolves to a zero-alpha colour by Frame.ToImage's
		// conversion path).
		draw.Draw(
			sheet,
			image.Rect(dstX, dstY, dstX+int(f.Width), dstY+int(f.Height)),
			img,
			image.Point{},
			draw.Over,
		)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, sheet); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	// Average per-frame duration in ms.  GAF stores duration in ticks
	// of TA's animation clock (1/30 sec each).  Most fx.gaf projectile
	// sequences use 1-2 ticks per frame; averaging keeps mixed-cadence
	// sequences from playing at the slowest frame's rate.
	frameMs := 33
	if frameCount > 0 && totalDuration > 0 {
		frameMs = int(float64(totalDuration) / float64(frameCount) * (1000.0 / 30.0))
		if frameMs < 16 {
			frameMs = 16 // floor at ~60 Hz — anything faster reads as no animation
		}
	}
	return &weaponBitmapResponse{
		Sheet:           base64.StdEncoding.EncodeToString(buf.Bytes()),
		FrameCount:      frameCount,
		FrameWidth:      cw,
		FrameHeight:     ch,
		SheetWidth:      cw * frameCount,
		SheetHeight:     ch,
		FrameDurationMs: frameMs,
		OriginX:         originX,
		OriginY:         originY,
	}, nil
}

func (sess *Session) _cacheWeaponBitmapMiss(key string) {
	sess.weaponBitmapMu.Lock()
	sess.weaponBitmapCache[key] = []byte{}
	sess.weaponBitmapMu.Unlock()
}
