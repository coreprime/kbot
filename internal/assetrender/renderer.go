// Package assetrender turns Total Annihilation game files into the byte
// streams a browser can display: raw passthrough, format-specific "describe"
// metadata, and image/video renderings.
//
// Every operation that needs to read a file — including the sidecar files a
// render depends on, such as a TNT map's companion .ota or a GAF's palette —
// hangs off a Renderer that owns a VirtualFileSystem. Callers construct one
// Renderer per mounted game and invoke its methods; nothing here reaches for a
// package-global filesystem.
package assetrender

import (
	"hash/fnv"
	"image/color"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/palettes"
	"github.com/coreprime/kbot/internal/cache"
	"github.com/coreprime/kbot/internal/palettepick"
)

// Options configures a Renderer.
type Options struct {
	// CacheDir is the root directory under which per-representation caches
	// (gaf-png, tnt-png, …) are created. When empty the Renderer runs without
	// an on-disk cache.
	CacheDir string
	// NoCache disables the on-disk cache even when CacheDir is set.
	NoCache bool
}

// Renderer produces representations of VFS files. It is safe for concurrent
// use: the cache map is guarded by a mutex and the underlying caches are
// themselves stateless filesystem wrappers.
type Renderer struct {
	vfs      *filesystem.VirtualFileSystem
	cacheDir string
	noCache  bool

	mu     sync.Mutex
	caches map[string]*cache.Cache
}

// Rendered is one produced representation ready to write to an HTTP response.
// Most renders carry their bytes in Body. Large, seekable results (transcoded
// video) instead set Path to an on-disk cache file so the HTTP layer can serve
// it with http.ServeFile and honour Range requests; when Path is set Body is
// empty.
type Rendered struct {
	ContentType string
	Body        []byte
	Path        string
}

// New builds a Renderer backed by vfs.
func New(vfs *filesystem.VirtualFileSystem, opts Options) *Renderer {
	return &Renderer{
		vfs:      vfs,
		cacheDir: opts.CacheDir,
		noCache:  opts.NoCache || opts.CacheDir == "",
		caches:   map[string]*cache.Cache{},
	}
}

// VFS exposes the underlying filesystem so HTTP handlers can list directories
// and stat files without a second mount.
func (r *Renderer) VFS() *filesystem.VirtualFileSystem { return r.vfs }

// Cache returns the named on-disk cache (e.g. "gaf-png"), creating it on first
// use. It returns nil when caching is disabled or the directory can't be
// created, so callers must tolerate a nil cache and simply render fresh.
func (r *Renderer) Cache(name string) *cache.Cache {
	if r.noCache {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.caches[name]; ok {
		return c
	}
	c, err := cache.New(filepath.Join(r.cacheDir, name))
	if err != nil {
		return nil
	}
	r.caches[name] = c
	return c
}

// renderCached returns the bytes for entry (key + ext) in the named cache,
// producing and persisting them on a miss. With caching disabled (or when the
// cache directory can't be created) it always produces fresh, so callers never
// need to special-case the no-cache path. A failed disk write is non-fatal: the
// freshly produced bytes are still returned.
func (r *Renderer) renderCached(cacheName, key, ext string, produce func() ([]byte, error)) ([]byte, error) {
	c := r.Cache(cacheName)
	if c == nil {
		return produce()
	}
	p := c.GetPath(key, ext)
	if b, err := os.ReadFile(p); err == nil {
		return b, nil
	}
	b, err := produce()
	if err != nil {
		return nil, err
	}
	_ = os.WriteFile(p, b, 0o644)
	return b, nil
}

// renderCachedFile is the file-path analogue of renderCached for results that
// are expensive and large enough to serve straight off disk (transcoded video,
// animated thumbnails). produce writes the finished artefact to the path it is
// handed; renderCachedFile stages that write through a temp file and renames it
// into place so a failed or interrupted produce never leaves a half-written
// entry in the cache. With caching disabled it produces into a temp file whose
// lifetime the caller must manage.
func (r *Renderer) renderCachedFile(cacheName, key, ext string, produce func(dst string) error) (string, error) {
	c := r.Cache(cacheName)
	if c == nil {
		// No cache: produce straight into a temp file the caller owns.
		f, err := os.CreateTemp("", "render-*"+ext)
		if err != nil {
			return "", err
		}
		dst := f.Name()
		_ = f.Close()
		if err := produce(dst); err != nil {
			_ = os.Remove(dst)
			return "", err
		}
		return dst, nil
	}

	dst := c.GetPath(key, ext)
	if _, err := os.Stat(dst); err == nil {
		return dst, nil
	}

	// Stage into a sibling temp file that keeps the target extension — some
	// producers (ffmpeg) pick their output muxer from it — then rename into
	// place so an interrupted produce never publishes a half-written entry.
	stage, err := os.CreateTemp(filepath.Dir(dst), "stage-*"+ext)
	if err != nil {
		return "", err
	}
	tmp := stage.Name()
	_ = stage.Close()
	if err := produce(tmp); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

// CacheKey returns a stable content hash for path. It prefers the MD5 the VFS
// precomputes at mount time and falls back to hashing data directly, so a
// representation's cache entry is keyed to the exact bytes that produced it.
func (r *Renderer) CacheKey(path string, data []byte) string {
	if r.vfs != nil {
		if md5Hash, ok := r.vfs.GetMD5(strings.ToLower(path)); ok {
			return md5Hash
		}
	}
	return cache.HashData(data)
}

// ResolvePalette picks the palette for rendering gafPath, honoring an optional
// override and otherwise using palettepick's auto-detection chain. It returns
// the palette plus a short provenance tag suitable for folding into a cache
// key so swapping palettes invalidates stale renders.
func (r *Renderer) ResolvePalette(gafPath, override string) (*gaf.Palette, string) {
	res, err := palettepick.Resolve(r.vfs, gafPath, override)
	if err != nil || res.Palette == nil {
		fallback, _ := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
		return fallback, "embedded"
	}
	tag := res.Source.String()
	if res.Path != "" {
		tag += ":" + res.Path
	}
	return res.Palette, tag
}

// GlobalPalette returns the install-wide color.Palette used to render index
// formats that carry no palette of their own (TNT, SCT). It reads
// palettes/palette.pal from the VFS and falls back to the embedded TA palette.
// Index 0 is forced transparent to match the game's treatment of the void.
func (r *Renderer) GlobalPalette() color.Palette {
	if r.vfs != nil {
		if palData, err := r.vfs.ReadFile("palettes/palette.pal"); err == nil && len(palData) >= 256*4 {
			return paletteFromRGBA(palData)
		}
	}
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		return nil
	}
	return pal.ColorModel()
}

func paletteFromRGBA(data []byte) color.Palette {
	palette := make(color.Palette, 256)
	for i := 0; i < 256 && i*4+2 < len(data); i++ {
		a := uint8(255)
		if i == 0 {
			a = 0
		}
		palette[i] = color.RGBA{data[i*4], data[i*4+1], data[i*4+2], a}
	}
	return palette
}

// RawContentType maps a file extension to the MIME type used when serving the
// file's bytes verbatim. The bool reports whether the type was recognised
// (false means the octet-stream default was used).
func RawContentType(ext string) (string, bool) {
	switch strings.ToLower(ext) {
	case ".tdf", ".fbi", ".gui", ".ota", ".bos", ".txt", ".cfg", ".tdf.txt":
		return "text/plain; charset=utf-8", true
	case ".htm", ".html":
		return "text/html; charset=utf-8", true
	case ".wav":
		return "audio/wav", true
	case ".mp3":
		return "audio/mpeg", true
	case ".mp4":
		return "video/mp4", true
	case ".png":
		return "image/png", true
	case ".jpg", ".jpeg":
		return "image/jpeg", true
	case ".gif":
		return "image/gif", true
	case ".bmp":
		return "image/bmp", true
	case ".webp":
		return "image/webp", true
	case ".svg":
		return "image/svg+xml", true
	default:
		return "application/octet-stream", false
	}
}

// TransparencyFromQuery converts the ?transparency= query value into a
// gaf.RenderOptions plus a short cache tag. Accepted forms: "" / "auto"
// (heuristic), "metadata", "none", or a "0".."255" palette index. Unknown
// values fall back to auto so a stale query can't break rendering.
func TransparencyFromQuery(q string) (gaf.RenderOptions, string) {
	switch strings.ToLower(q) {
	case "", "auto":
		return gaf.RenderOptions{Mode: gaf.TransparencyModeAuto}, "t-auto"
	case "metadata", "meta":
		return gaf.RenderOptions{Mode: gaf.TransparencyModeMetadata}, "t-meta"
	case "none", "opaque", "off":
		return gaf.RenderOptions{Mode: gaf.TransparencyModeNone}, "t-none"
	}
	if n, err := strconv.Atoi(q); err == nil && n >= 0 && n <= 255 {
		return gaf.RenderOptions{Mode: gaf.TransparencyModeIndex, Index: uint8(n)}, "t-i" + pad3(n)
	}
	return gaf.RenderOptions{Mode: gaf.TransparencyModeAuto}, "t-auto"
}

// paletteCacheSuffix derives a short, fixed-width hash from a palette tag so it
// can be folded into a cache key without exploding its length.
func paletteCacheSuffix(tag string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(tag))
	return "p" + hex8(h.Sum32())
}

func hex8(v uint32) string {
	const digits = "0123456789abcdef"
	b := [8]byte{}
	for i := 7; i >= 0; i-- {
		b[i] = digits[v&0xf]
		v >>= 4
	}
	return string(b[:])
}

func pad3(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}
