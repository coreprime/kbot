package explorer

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/cache"
	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/fnt"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/smacker"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

//go:embed web/dist/*
var spaFS embed.FS
var videoCache *cache.Cache
var gifCache *cache.Cache
var pngCache *cache.Cache
var apngCache *cache.Cache
var zrbThumbCache *cache.Cache
var sctCache *cache.Cache
var tntCache *cache.Cache
var cacheWarmer *CacheWarmer
var logger *zap.Logger



// newLogger creates a zap logger for the explorer
func newLogger(debug bool) *zap.Logger {
	tty := isTerminal(os.Stderr)

	var config zap.Config
	if debug {
		config = zap.NewDevelopmentConfig()
	} else if tty {
		// Console encoder for terminal — supports ANSI color codes.
		config = zap.NewDevelopmentConfig()
		config.EncoderConfig.TimeKey = "timestamp"
		config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
		config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
		config.Level = zap.NewAtomicLevelAt(zap.InfoLevel)
	} else {
		// JSON encoder for containers/pipes — no color.
		config = zap.NewProductionConfig()
		config.EncoderConfig.TimeKey = "timestamp"
		config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
	}

	config.OutputPaths = []string{"stderr"}
	config.ErrorOutputPaths = []string{"stderr"}

	logger, err := config.Build()
	if err != nil {
		panic(fmt.Sprintf("Failed to create logger: %v", err))
	}

	return logger
}

// isTerminal reports whether f is a terminal (TTY).
func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// Breadcrumb represents a navigation breadcrumb
type Breadcrumb struct {
	Name   string
	Path   string
	IsLast bool
}

// runWebServer starts the HTTP server
func runWebServer(vfsInstance *filesystem.VirtualFileSystem, port int) error {
	// Initialize logger (false = production mode, true = development mode)
	logger = newLogger(false)
	defer func() {
		_ = logger.Sync()
	}()
	
	logger.Info("Starting KBot Explorer web server",
		zap.Int("port", port),
		zap.String("mode", "production"))
	

	// Clear caches if requested
	if clearCache {
		logger.Info("Clearing all caches")
		if err := clearAllCaches(); err != nil {
			return fmt.Errorf("failed to clear caches: %w", err)
		}
		logger.Info("All caches cleared")
	}

	// Initialize Prometheus registry and metrics
	registry := prometheus.NewRegistry()
	metrics = InitMetrics(registry)
	
	// Initialize video cache
	var err error
	videoCache, err = cache.New(".cache/zrb-mp4")
	if err != nil {
		return fmt.Errorf("failed to create cache: %w", err)
	}
	
	// Initialize GIF cache for GAF animations
	gifCache, err = cache.New(".cache/gaf-gif")
	if err != nil {
		return fmt.Errorf("failed to create GIF cache: %w", err)
	}
	
	// Initialize PNG cache for GAF frames
	pngCache, err = cache.New(".cache/gaf-png")
	if err != nil {
		return fmt.Errorf("failed to create PNG cache: %w", err)
	}
	
	// Initialize APNG cache for GAF sequences
	apngCache, err = cache.New(".cache/gaf-apng")
	if err != nil {
		return fmt.Errorf("failed to create APNG cache: %w", err)
	}
	
	// Initialize PCX-PNG cache
	var pcxPngCache *cache.Cache
	pcxPngCache, err = cache.New(".cache/pcx-png")
	if err != nil {
		return fmt.Errorf("failed to create PCX-PNG cache: %w", err)
	}
	
	// Initialize TNT cache
	tntCache, err = cache.New(".cache/tnt-png")
	if err != nil {
		return fmt.Errorf("failed to create TNT cache: %w", err)
	}

	// Initialize SCT cache
	sctCache, err = cache.New(".cache/sct-png")
	if err != nil {
		return fmt.Errorf("failed to create SCT cache: %w", err)
	}

	// Initialize ZRB thumbnail cache
	zrbThumbCache, err = cache.New(".cache/zrb-thumb")
	if err != nil {
		return fmt.Errorf("failed to create ZRB thumbnail cache: %w", err)
	}

	// Set VFS metrics callback
	vfsInstance.SetMetricsCallback(metrics.RecordVFSRead)
	
	// Initialize and start cache warmer
	cacheWarmerConfig := DefaultCacheWarmerConfig()
	// WorkerCount is set by DefaultCacheWarmerConfig from GOMAXPROCS.
	cacheWarmerConfig.MaxFileSizeMB = 50
	cacheWarmer = NewCacheWarmer(cacheWarmerConfig, vfsInstance, videoCache, gifCache, pngCache, apngCache, pcxPngCache, zrbThumbCache, sctCache, tntCache, metrics, logger)
	cacheWarmer.Start()
	
	// Add cache warmer stats endpoint
	http.HandleFunc("/cache-stats", handleCacheStats)
	
	// Prometheus metrics endpoint
	http.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	
	// SSE endpoint for live cache warming progress.
	http.HandleFunc("/api/events", handleSSE)

	// JSON API endpoints
	http.HandleFunc("/api/search", handleAPISearch)
	http.HandleFunc("/api/stats", handleAPIStats)
	http.HandleFunc("/api/browse/", handleAPIBrowse)
	http.HandleFunc("/api/describe/", handleAPIDescribe)
	http.HandleFunc("/api/view/", handleAPIView)

	// Binary asset endpoints (not JSON — serve raw bytes)
	http.HandleFunc("/fnt-sheet/", handleFntSheet)
	http.HandleFunc("/fnt-preview/", handleFntPreview)
	http.HandleFunc("/tnt-tile/", handleTNTTile)
	http.HandleFunc("/tnt-tilemap/", handleTNTTileMap)
	http.HandleFunc("/tnt-minimap/", handleTNTMinimap)
	http.HandleFunc("/tnt-heightmap/", handleTNTHeightMap)
	http.HandleFunc("/sct-tile/", handleSCTTile)
	http.HandleFunc("/sct-tilemap/", handleSCTTileMap)
	http.HandleFunc("/sct-heightmap/", handleSCTHeightMap)
	http.HandleFunc("/sct-minimap/", handleSCTMinimap)
	http.HandleFunc("/zrb-thumb/", handleZRBThumb)
	http.HandleFunc("/raw/", handleWebRaw)
	http.HandleFunc("/gif/", handleWebGIF)
	http.HandleFunc("/png/", handleWebPNG)
	http.HandleFunc("/apng/", handleWebAPNG)
	http.HandleFunc("/pcx/", handleWebPCX)
	http.HandleFunc("/video/", handleWebVideo)

	// SPA fallback — serve React app for all other routes
	http.HandleFunc("/", handleSPA)

	addr := fmt.Sprintf(":%d", port)
	
	logger.Info("Starting KBot Explorer web server",
		zap.Int("port", port),
		zap.String("url", fmt.Sprintf("http://localhost:%d", port)),
		zap.String("browse_url", fmt.Sprintf("http://localhost:%d/browse/", port)))

	return http.ListenAndServe(addr, nil)
}

// handleSPA serves the React single-page application.
// Static assets (JS/CSS) are served from the embedded filesystem.
// All other paths receive index.html so client-side routing works.
func handleSPA(w http.ResponseWriter, r *http.Request) {
	// Try to serve a static file from the SPA build.
	fsPath := "web/dist" + r.URL.Path
	if r.URL.Path == "/" {
		fsPath = "web/dist/index.html"
	}

	if data, err := spaFS.ReadFile(fsPath); err == nil {
		ext := filepath.Ext(r.URL.Path)
		switch ext {
		case ".js":
			w.Header().Set("Content-Type", "application/javascript")
		case ".css":
			w.Header().Set("Content-Type", "text/css")
		case ".svg":
			w.Header().Set("Content-Type", "image/svg+xml")
		case ".png":
			w.Header().Set("Content-Type", "image/png")
		case ".ico":
			w.Header().Set("Content-Type", "image/x-icon")
		case ".json":
			w.Header().Set("Content-Type", "application/json")
		default:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		}
		_, _ = w.Write(data)
		return
	}

	// Fallback: serve index.html for client-side routing
	data, err := spaFS.ReadFile("web/dist/index.html")
	if err != nil {
		http.Error(w, "SPA not built — run: cd internal/explorer/web && npm run build", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

// handleWebIndex shows the main page

// handleWebBrowse shows directory listings

// handleWebRaw serves raw file content
func handleWebRaw(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimPrefix(r.URL.Path, "/raw/")
	
	// Record metrics
	if metrics != nil {
		ext := strings.ToLower(filepath.Ext(filePath))
		metrics.RecordRawFile(ext)
	}

	// Check for source parameter
	source := r.URL.Query().Get("source")

	var data []byte
	var readErr error

	if source != "" {
		// Read from specific source
		data, readErr = vfs.ReadFileFromSource(filePath, source)
	} else {
		// Read default file
		data, readErr = vfs.ReadFile(filePath)
	}

	if readErr != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Set content type based on extension
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".tdf", ".fbi", ".gui", ".txt":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	case ".wav":
		w.Header().Set("Content-Type", "audio/wav")
	case ".mp3":
		w.Header().Set("Content-Type", "audio/mpeg")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(filePath)))

	if _, err := w.Write(data); err != nil {
		logger.Error("Failed to write response", zap.Error(err))
	}
}

// handleWebDescribe shows metadata for supported file formats

// handleWebGIF converts GAF files to GIF and serves them
func handleWebGIF(w http.ResponseWriter, r *http.Request) {
	fullPath := strings.TrimPrefix(r.URL.Path, "/gif/")
	
	// Record GIF request
	if metrics != nil {
		metrics.RecordGIFRequest()
	}

	// Extract sequence and frame indices if provided
	// Format: /gif/file.gaf/seqIndex or /gif/file.gaf/seqIndex/frameIndex
	parts := strings.Split(fullPath, "/")
	seqIndex := 0
	frameIndex := -1 // -1 means all frames (animated GIF)

	// Find the .gaf file in the path
	gafIndex := -1
	for i, part := range parts {
		if strings.HasSuffix(strings.ToLower(part), ".gaf") {
			gafIndex = i
			break
		}
	}

	if gafIndex == -1 {
		http.Error(w, "No GAF file found in path", http.StatusBadRequest)
		return
	}

	// Everything after the .gaf file is sequence/frame indices
	// /file.gaf/0 = sequence 0, all frames
	// /file.gaf/0/0 = sequence 0, frame 0
	filePath := strings.Join(parts[:gafIndex+1], "/")

	if gafIndex+1 < len(parts) && parts[gafIndex+1] != "" {
		if idx, err := strconv.Atoi(parts[gafIndex+1]); err == nil {
			seqIndex = idx
		}
	}

	if gafIndex+2 < len(parts) && parts[gafIndex+2] != "" {
		if idx, err := strconv.Atoi(parts[gafIndex+2]); err == nil {
			frameIndex = idx
		}
	}

	// Read file from VFS
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, fmt.Sprintf("File not found: %s", filePath), http.StatusNotFound)
		return
	}
	
	// Create cache key suffix based on sequence and frame
	// Format: -seq<N>.gif for animations or -seq<N>-frame<F>.gif for single frames
	cacheExt := fmt.Sprintf("-seq%d", seqIndex)
	if frameIndex >= 0 {
		cacheExt += fmt.Sprintf("-frame%d", frameIndex)
	}
	cacheExt += ".gif"
	
	// Check cache first using VFS MD5 if available
	var cacheKey string
	normalizedPath := strings.ToLower(strings.TrimPrefix(filePath, "/"))
	if md5Hash, ok := vfs.GetMD5(normalizedPath); ok {
		// Use pre-calculated MD5 from VFS
		cacheKey = md5Hash
	} else {
		// Fall back to calculating MD5 (shouldn't happen often after startup)
		cacheKey = cache.HashData(data)
	}
	
	cachedPath := gifCache.GetPath(cacheKey, cacheExt)
	if _, err := os.Stat(cachedPath); err == nil {
		// Cache hit!
		if metrics != nil {
			metrics.RecordGIFCacheHit()
		}
		http.ServeFile(w, r, cachedPath)
		return
	}
	
	// Cache miss
	if metrics != nil {
		metrics.RecordGIFCacheMiss()
	}

	// Create bytes.Reader for seeking (no temp file needed!)
	bytesReader := bytes.NewReader(data)

	// Parse GAF
	reader, err := gaf.LoadFromReader(bytesReader)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error parsing GAF: %v", err), http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }() // No-op for bytes.Reader, but safe

	sequences, err := reader.ReadSequences()
	if err != nil {
		http.Error(w, fmt.Sprintf("Error reading sequences: %v", err), http.StatusInternalServerError)
		return
	}

	if seqIndex >= len(sequences) {
		http.Error(w, "Sequence index out of range", http.StatusBadRequest)
		return
	}

	seq := sequences[seqIndex]

	// Check frame index if specified
	if frameIndex >= 0 {
		if frameIndex >= len(seq.Frames) {
			http.Error(w, "Frame index out of range", http.StatusBadRequest)
			return
		}
	}

	// Load palette - try VFS first, then fall back to embedded default
	palette := loadPalette()

	// Convert to GIF - write to buffer for caching
	var gifBuffer bytes.Buffer
	
	if frameIndex >= 0 {
		// Single frame - create a sequence with just this frame
		singleFrame := &gaf.Sequence{
			Name:   fmt.Sprintf("%s_frame%d", seq.Name, frameIndex),
			Frames: []*gaf.Frame{seq.Frames[frameIndex]},
		}
		if err := singleFrame.WriteGIF(&gifBuffer, palette); err != nil {
			http.Error(w, fmt.Sprintf("Error generating GIF: %v", err), http.StatusInternalServerError)
			return
		}
	} else {
		// All frames (animated)
		if err := seq.WriteGIF(&gifBuffer, palette); err != nil {
			http.Error(w, fmt.Sprintf("Error generating GIF: %v", err), http.StatusInternalServerError)
			return
		}
	}
	
	// Record GIF generation
	if metrics != nil {
		metrics.RecordGIFGeneration()
	}
	
	// Save to cache
	gifData := gifBuffer.Bytes()
	tmpGif, err := os.CreateTemp("", "gaf-*.gif")
	if err == nil {
		defer func() { _ = os.Remove(tmpGif.Name()) }()
		defer func() { _ = tmpGif.Close() }()
		
		if _, err := tmpGif.Write(gifData); err == nil {
			if err := tmpGif.Close(); err != nil {
				logger.Error("Failed to close temp GIF", zap.Error(err))
			}
			// Cache it using the cache key and extension
			cachedPath, _ = gifCache.Put([]byte(cacheKey), cacheExt, tmpGif.Name())
		}
	}
	
	// Serve the GIF
	w.Header().Set("Content-Type", "image/gif")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	
	if cachedPath != "" && cachedPath != gifCache.GetPath(cacheKey, cacheExt) {
		// Serve from newly cached file
		http.ServeFile(w, r, cachedPath)
	} else {
		// Serve from buffer
		if _, err := w.Write(gifData); err != nil {
			logger.Error("Failed to write GIF response", zap.Error(err))
		}
	}
}

// formatHexDump formats binary data as a hex dump with ASCII column
func formatHexDump(data []byte) string {
	var result strings.Builder

	// Header
	result.WriteString("Offset      00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F  ASCII\n")
	result.WriteString("─────────── ───────────────────────────────────────────  ────────────────\n")

	for offset := 0; offset < len(data); offset += 16 {
		// Offset column
		fmt.Fprintf(&result, "0x%08X  ", offset)

		// Hex bytes
		lineEnd := offset + 16
		if lineEnd > len(data) {
			lineEnd = len(data)
		}

		for i := offset; i < lineEnd; i++ {
			fmt.Fprintf(&result, "%02X ", data[i])
		}

		// Padding for incomplete lines
		for i := lineEnd; i < offset+16; i++ {
			result.WriteString("   ")
		}

		result.WriteString(" ")

		// ASCII column
		for i := offset; i < lineEnd; i++ {
			b := data[i]
			if b >= 32 && b <= 126 {
				result.WriteByte(b)
			} else {
				result.WriteByte('.')
			}
		}

		result.WriteString("\n")
	}

	return result.String()
}

// handleWebPCX converts PCX files to GIF for display
func handleWebPCX(w http.ResponseWriter, r *http.Request) {
	// Extract path
	path := strings.TrimPrefix(r.URL.Path, "/pcx/")
	if path == "" {
		http.Error(w, "PCX path required", http.StatusBadRequest)
		return
	}

	// Get palette parameter (optional)
	palettePath := r.URL.Query().Get("palette")
	var palette *gaf.Palette

	if palettePath != "" {
		// Load custom palette from VFS
		palReader, err := vfs.Open(palettePath)
		if err == nil {
			defer func() { _ = palReader.Close() }()
			palData, err := io.ReadAll(palReader)
			if err == nil {
				palette, _ = gaf.LoadPaletteFromBytes(palData)
			}
		}
	}

	// If no custom palette or loading failed, use default
	if palette == nil {
		palette, _ = gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	}

	// Open file from VFS
	reader, err := vfs.Open(path)
	if err != nil {
		http.Error(w, fmt.Sprintf("File not found: %v", err), http.StatusNotFound)
		return
	}
	defer func() { _ = reader.Close() }()

	// Convert to GIF and stream
	w.Header().Set("Content-Type", "image/gif")
	w.Header().Set("Cache-Control", "public, max-age=3600")

	if err := pcx.ConvertToGIFWithPalette(w, reader, palette); err != nil {
		logger.Error("Failed to convert PCX to GIF", zap.String("file", path), zap.Error(err))
		http.Error(w, "Failed to convert PCX", http.StatusInternalServerError)
		return
	}
}

// handleWebView shows a unified tabbed view of files

// isTextContent checks if data appears to be valid text
func isTextContent(data []byte) bool {
	if len(data) == 0 {
		return false
	}

	// Sample first 512 bytes
	sample := data
	if len(sample) > 512 {
		sample = data[:512]
	}

	// Count printable characters
	printable := 0
	for _, b := range sample {
		if (b >= 0x20 && b <= 0x7E) || b == '\t' || b == '\n' || b == '\r' {
			printable++
		}
	}

	// If >80% printable, consider it text
	return printable > (len(sample) * 80 / 100)
}

// loadPalette attempts to load palette from VFS, falls back to embedded default
func loadPalette() *gaf.Palette {
	// Try to load from VFS at standard location
	paletteData, err := vfs.ReadFile("palettes/palette.pal")
	if err == nil && len(paletteData) == 1024 {
		palette, err := gaf.LoadPaletteFromBytes(paletteData)
		if err == nil {
			return palette
		}
	}

	// Fall back to embedded default palette
	palette, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		// This should never happen with valid embedded palette
		return nil
	}
	return palette
}

// handleWebVideo converts and streams Smacker videos as MP4
// ── SSE event stream ────────────────────────────────────────────────────────

func handleSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch := cacheWarmer.Subscribe()
	defer cacheWarmer.Unsubscribe(ch)

	// Send current status immediately so reconnecting clients resume.
	if cacheWarmer.IsWarming() {
		// Send current worker states.
		states := cacheWarmer.GetWorkerStates()
		for _, ws := range states {
			if ws.Type == "" {
				continue
			}
			data, _ := json.Marshal(ws)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
		}
		flusher.Flush()
	} else {
		progress := cacheWarmer.GetProgress()
		total := progress["total"]
		if total > 0 {
			doneEvt := CacheEvent{Type: "done", Total: total, Processed: progress["processed"], Cached: progress["cached"]}
			data, _ := json.Marshal(doneEvt)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, _ := json.Marshal(evt)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}

// ── Font rendering handlers ─────────────────────────────────────────────────

func handleFntSheet(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimPrefix(r.URL.Path, "/fnt-sheet/")
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	font, err := fnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "Failed to parse font", http.StatusInternalServerError)
		return
	}

	fg := color.RGBA{220, 220, 220, 255}
	bg := color.RGBA{30, 30, 30, 255}
	img := font.RenderSheet(fg, bg)

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_ = png.Encode(w, img)
}

func handleFntPreview(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimPrefix(r.URL.Path, "/fnt-preview/")
	text := r.URL.Query().Get("text")
	if text == "" {
		text = "The quick brown fox jumps over the lazy dog. 0123456789"
	}

	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	font, err := fnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "Failed to parse font", http.StatusInternalServerError)
		return
	}

	fg := color.RGBA{220, 220, 220, 255}
	bg := color.RGBA{30, 30, 30, 255}
	img := font.RenderText(text, fg, bg)

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_ = png.Encode(w, img)
}

// ── Tile rendering helpers ──────────────────────────────────────────────────

// renderTile32 creates a 32×32 RGBA image from palette-indexed pixel data.
func renderTile32(pixels []byte, pal color.Palette) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			palIdx := pixels[y*32+x]
			c := color.RGBA{0, 0, 0, 255}
			if int(palIdx) < len(pal) {
				r, g, b, a := pal[palIdx].RGBA()
				c = color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func serveTileImage(w http.ResponseWriter, r *http.Request, prefix string, tileCache *cache.Cache, getTiles func([]byte) ([][]byte, error)) {
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	lastSlash := strings.LastIndex(rest, "/")
	if lastSlash < 0 {
		http.Error(w, "Missing tile index", http.StatusBadRequest)
		return
	}
	filePath := rest[:lastSlash]
	idxStr := rest[lastSlash+1:]

	idx := 0
	if _, err := fmt.Sscanf(idxStr, "%d", &idx); err != nil {
		http.Error(w, "Invalid tile index", http.StatusBadRequest)
		return
	}

	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Check tile cache first.
	cacheExt := fmt.Sprintf(".tile%d.png", idx)
	if cachedPath, ok := tileCache.Has(data, cacheExt); ok {
		if _, statErr := os.Stat(cachedPath); statErr == nil {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, cachedPath)
			return
		}
	}

	tiles, err := getTiles(data)
	if err != nil || idx < 0 || idx >= len(tiles) {
		http.Error(w, "Tile not found", http.StatusNotFound)
		return
	}

	pal := loadVFSPalette()
	img := renderTile32(tiles[idx], pal)

	// Lazy-cache the rendered tile for future requests.
	_ = cacheImage(tileCache, data, cacheExt, img)

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_ = png.Encode(w, img)
}

func handleSCTTile(w http.ResponseWriter, r *http.Request) {
	serveTileImage(w, r, "/sct-tile/", sctCache, func(data []byte) ([][]byte, error) {
		s, err := sct.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		return s.Tiles, nil
	})
}

func handleTNTTile(w http.ResponseWriter, r *http.Request) {
	serveTileImage(w, r, "/tnt-tile/", tntCache, func(data []byte) ([][]byte, error) {
		m, err := tnt.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		return m.Tiles, nil
	})
}

// ── TNT map handlers ───────────────────────────────────────────────────────

func handleTNTTileMap(w http.ResponseWriter, r *http.Request) {
	serveTNTImage(w, r, "/tnt-tilemap/", "tilemap", func(m *tnt.Map, pal color.Palette) image.Image {
		return m.RenderTileMap(pal)
	})
}

func handleTNTMinimap(w http.ResponseWriter, r *http.Request) {
	serveTNTImage(w, r, "/tnt-minimap/", "minimap", func(m *tnt.Map, pal color.Palette) image.Image {
		img := m.RenderMinimap(pal)
		if img == nil {
			return image.NewRGBA(image.Rect(0, 0, 1, 1))
		}
		return img
	})
}

func handleTNTHeightMap(w http.ResponseWriter, r *http.Request) {
	serveTNTImage(w, r, "/tnt-heightmap/", "heightmap", func(m *tnt.Map, _ color.Palette) image.Image {
		img := m.RenderHeightMap()
		if img == nil {
			return image.NewGray(image.Rect(0, 0, 1, 1))
		}
		return img
	})
}

func serveTNTImage(w http.ResponseWriter, r *http.Request, prefix, suffix string, render func(*tnt.Map, color.Palette) image.Image) {
	filePath := strings.TrimPrefix(r.URL.Path, prefix)
	if filePath == "" {
		http.Error(w, "No file specified", http.StatusBadRequest)
		return
	}

	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	cacheExt := "." + suffix + ".png"
	if cachedPath, ok := tntCache.Has(data, cacheExt); ok {
		if _, statErr := os.Stat(cachedPath); statErr == nil {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, cachedPath)
			return
		}
	}

	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "Failed to parse TNT", http.StatusInternalServerError)
		return
	}

	pal := loadVFSPalette()
	img := render(m, pal)

	tmpFile, err := os.CreateTemp("", "tnt-*.png")
	if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}
	defer func() { _ = os.Remove(tmpFile.Name()) }()

	if err := tnt.WritePNG(tmpFile, img); err != nil {
		_ = tmpFile.Close()
		http.Error(w, "Failed to encode PNG", http.StatusInternalServerError)
		return
	}
	_ = tmpFile.Close()

	cachedPath, err := tntCache.Put(data, cacheExt, tmpFile.Name())
	if err != nil {
		w.Header().Set("Content-Type", "image/png")
		http.ServeFile(w, r, tmpFile.Name())
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, cachedPath)
}

// ── SCT tile/height/minimap handlers ───────────────────────────────────────

func loadVFSPalette() color.Palette {
	palData, err := vfs.ReadFile("palettes/palette.pal")
	if err != nil {
		pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
		if err != nil {
			return nil
		}
		return pal.ColorModel()
	}
	palette := make(color.Palette, 256)
	for i := 0; i < 256 && i*4+2 < len(palData); i++ {
		a := uint8(255)
		if i == 0 {
			a = 0
		}
		palette[i] = color.RGBA{palData[i*4], palData[i*4+1], palData[i*4+2], a}
	}
	return palette
}

func handleSCTTileMap(w http.ResponseWriter, r *http.Request) {
	serveSCTImage(w, r, "/sct-tilemap/", "tilemap", func(s *sct.Section, pal color.Palette) image.Image {
		return s.RenderTileMap(pal)
	})
}

func handleSCTHeightMap(w http.ResponseWriter, r *http.Request) {
	serveSCTImage(w, r, "/sct-heightmap/", "heightmap", func(s *sct.Section, _ color.Palette) image.Image {
		img := s.RenderHeightMap()
		if img == nil {
			return image.NewGray(image.Rect(0, 0, 1, 1))
		}
		return img
	})
}

func handleSCTMinimap(w http.ResponseWriter, r *http.Request) {
	serveSCTImage(w, r, "/sct-minimap/", "minimap", func(s *sct.Section, pal color.Palette) image.Image {
		img := s.RenderMinimap(pal)
		if img == nil {
			return image.NewRGBA(image.Rect(0, 0, 1, 1))
		}
		return img
	})
}

func serveSCTImage(w http.ResponseWriter, r *http.Request, prefix, suffix string, render func(*sct.Section, color.Palette) image.Image) {
	filePath := strings.TrimPrefix(r.URL.Path, prefix)
	if filePath == "" {
		http.Error(w, "No file specified", http.StatusBadRequest)
		return
	}

	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Check cache.
	cacheExt := "." + suffix + ".png"
	if cachedPath, ok := sctCache.Has(data, cacheExt); ok {
		if _, statErr := os.Stat(cachedPath); statErr == nil {
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, cachedPath)
			return
		}
	}

	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "Failed to parse SCT", http.StatusInternalServerError)
		return
	}

	pal := loadVFSPalette()
	img := render(section, pal)

	// Write to temp file, cache, and serve.
	tmpFile, err := os.CreateTemp("", "sct-*.png")
	if err != nil {
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}
	defer func() { _ = os.Remove(tmpFile.Name()) }()

	if err := sct.WritePNG(tmpFile, img); err != nil {
		_ = tmpFile.Close()
		http.Error(w, "Failed to encode PNG", http.StatusInternalServerError)
		return
	}
	_ = tmpFile.Close()

	cachedPath, err := sctCache.Put(data, cacheExt, tmpFile.Name())
	if err != nil {
		// Serve directly without caching.
		w.Header().Set("Content-Type", "image/png")
		http.ServeFile(w, r, tmpFile.Name())
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, cachedPath)
}

// handleZRBThumb serves pre-generated APNG thumbnails for ZRB/SMK video files.
func handleZRBThumb(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimPrefix(r.URL.Path, "/zrb-thumb/")
	if filePath == "" {
		http.Error(w, "No file specified", http.StatusBadRequest)
		return
	}

	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Check cache.
	if cachedPath, ok := zrbThumbCache.Has(data, ".apng"); ok {
		if _, err := os.Stat(cachedPath); err == nil {
			w.Header().Set("Content-Type", "image/apng")
			w.Header().Set("Cache-Control", "public, max-age=86400")
			http.ServeFile(w, r, cachedPath)
			return
		}
	}

	// Generate on the fly (and cache).
	thumbPath, err := generateZRBThumb(data)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to generate thumbnail: %v", err), http.StatusInternalServerError)
		return
	}
	defer func() { _ = os.Remove(thumbPath) }()

	cachedPath, err := zrbThumbCache.Put(data, ".apng", thumbPath)
	if err != nil {
		http.Error(w, "Cache error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "image/apng")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, cachedPath)
}

// generateZRBThumb creates an APNG thumbnail from a ZRB/SMK file by
// extracting frames at 5% intervals and stitching them together.
// Returns the path to the temporary APNG file.
func generateZRBThumb(data []byte) (string, error) {
	// Write source to temp file.
	tmpSrc, err := os.CreateTemp("", "zrb-thumb-src-*.smk")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.Remove(tmpSrc.Name()) }()
	_, _ = tmpSrc.Write(data)
	_ = tmpSrc.Close()

	// Extract frame count via ffprobe.
	frameCountStr, err := exec.Command("ffprobe",
		"-v", "error",
		"-count_frames",
		"-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames",
		"-of", "csv=p=0",
		tmpSrc.Name(),
	).Output()
	if err != nil {
		return "", fmt.Errorf("ffprobe failed: %w", err)
	}

	totalFrames := 0
	_, _ = fmt.Sscanf(strings.TrimSpace(string(frameCountStr)), "%d", &totalFrames)
	if totalFrames < 2 {
		totalFrames = 20 // fallback
	}

	// Create temp dir for extracted frames.
	tmpDir, err := os.MkdirTemp("", "zrb-thumb-frames-*")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	// Build select filter: pick a frame every 5% (20 frames total).
	interval := totalFrames / 20
	if interval < 1 {
		interval = 1
	}
	selectExpr := fmt.Sprintf("not(mod(n\\,%d))", interval)

	// Extract frames using ffmpeg.
	err = exec.Command("ffmpeg",
		"-y", "-v", "error",
		"-i", tmpSrc.Name(),
		"-vf", fmt.Sprintf("select='%s',scale=128:-1:flags=neighbor", selectExpr),
		"-vsync", "vfr",
		"-frames:v", "20",
		filepath.Join(tmpDir, "frame_%03d.png"),
	).Run()
	if err != nil {
		return "", fmt.Errorf("ffmpeg frame extraction failed: %w", err)
	}

	// Assemble frames into APNG using ffmpeg.
	tmpOut, err := os.CreateTemp("", "zrb-thumb-*.apng")
	if err != nil {
		return "", err
	}
	_ = tmpOut.Close()

	err = exec.Command("ffmpeg",
		"-y", "-v", "error",
		"-framerate", "2",
		"-i", filepath.Join(tmpDir, "frame_%03d.png"),
		"-plays", "0",
		"-f", "apng",
		tmpOut.Name(),
	).Run()
	if err != nil {
		_ = os.Remove(tmpOut.Name())
		return "", fmt.Errorf("ffmpeg APNG assembly failed: %w", err)
	}

	return tmpOut.Name(), nil
}

func handleWebVideo(w http.ResponseWriter, r *http.Request) {
	// Extract file path from URL
	filePath := strings.TrimPrefix(r.URL.Path, "/video/")
	if filePath == "" {
		http.Error(w, "File path required", http.StatusBadRequest)
		return
	}
	
	// Record video request
	if metrics != nil {
		metrics.RecordVideoRequest()
	}
	
	// Read the Smacker file from VFS
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, fmt.Sprintf("File not found: %s", filePath), http.StatusNotFound)
		return
	}
	
	// Check cache first
	if cachedPath, ok := videoCache.Has(data, ".mp4"); ok {
		// Cache hit!
		if metrics != nil {
			metrics.RecordVideoCacheHit()
		}
		http.ServeFile(w, r, cachedPath)
		return
	}
	
	// Cache miss
	if metrics != nil {
		metrics.RecordVideoCacheMiss()
	}
	
	// Not cached - convert it
	tmpSmk, err := os.CreateTemp("", "smacker-*.smk")
	if err != nil {
		http.Error(w, "Failed to create temp file", http.StatusInternalServerError)
		return
	}
	defer func() { _ = os.Remove(tmpSmk.Name()) }()
	defer func() { _ = tmpSmk.Close() }()
	
	if _, err := tmpSmk.Write(data); err != nil {
		http.Error(w, "Failed to write temp file", http.StatusInternalServerError)
		return
	}
	_ = tmpSmk.Close()
	
	tmpMp4 := strings.TrimSuffix(tmpSmk.Name(), ".smk") + ".mp4"
	defer func() { _ = os.Remove(tmpMp4) }()
	
	if err := smacker.ConvertToMP4(tmpSmk.Name(), tmpMp4); err != nil {
		http.Error(w, fmt.Sprintf("Conversion failed: %v", err), http.StatusInternalServerError)
		return
	}
	
	// Record FFmpeg generation
	if metrics != nil {
		metrics.RecordVideoGeneration()
	}
	
	// Cache the result
	cachedPath, _ := videoCache.Put(data, ".mp4", tmpMp4)
	
	// Serve from cache
	http.ServeFile(w, r, cachedPath)
}

// handleCacheStats returns cache warming progress
func handleCacheStats(w http.ResponseWriter, r *http.Request) {
	if cacheWarmer == nil {
		http.Error(w, "Cache warmer not initialized", http.StatusServiceUnavailable)
		return
	}
	
	progress := cacheWarmer.GetProgress()
	
	w.Header().Set("Content-Type", "application/json")
	if _, err := fmt.Fprintf(w, `{
  "total_files": %d,
  "processed": %d,
  "cached": %d,
  "skipped_precached": %d,
  "skipped_errors": %d,
  "errors": %d,
  "videos_cached": %d,
  "gifs_cached": %d,
  "progress_percent": %.1f
}`,
		progress["total"],
		progress["processed"],
		progress["cached"],
		progress["skipped_precached"],
		progress["skipped_errors"],
		progress["errors"],
		progress["videos"],
		progress["gifs"],
		calculateProgress(progress),
	); err != nil {
		logger.Error("Failed to write cache stats response", zap.Error(err))
	}
}



// handleWebPNG converts GAF frames to PNG and serves them
func handleWebPNG(w http.ResponseWriter, r *http.Request) {
	fullPath := strings.TrimPrefix(r.URL.Path, "/png/")
	
	// Extract sequence and frame indices
	// Format: /png/file.gaf/seqIndex/frameIndex
	parts := strings.Split(fullPath, "/")
	seqIndex := 0
	frameIndex := 0

	// Find the .gaf file in the path
	gafIndex := -1
	for i, part := range parts {
		if strings.HasSuffix(strings.ToLower(part), ".gaf") {
			gafIndex = i
			break
		}
	}

	if gafIndex == -1 {
		http.Error(w, "No GAF file found in path", http.StatusBadRequest)
		return
	}

	filePath := strings.Join(parts[:gafIndex+1], "/")

	if gafIndex+1 < len(parts) && parts[gafIndex+1] != "" {
		if idx, err := strconv.Atoi(parts[gafIndex+1]); err == nil {
			seqIndex = idx
		}
	}

	if gafIndex+2 < len(parts) && parts[gafIndex+2] != "" {
		if idx, err := strconv.Atoi(parts[gafIndex+2]); err == nil {
			frameIndex = idx
		}
	}

	// Read file from VFS
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, fmt.Sprintf("File not found: %s", filePath), http.StatusNotFound)
		return
	}
	
	// Create cache key
	var cacheKey string
	normalizedPath := strings.ToLower(strings.TrimPrefix(filePath, "/"))
	if md5Hash, ok := vfs.GetMD5(normalizedPath); ok {
		cacheKey = md5Hash
	} else {
		cacheKey = cache.HashData(data)
	}
	
	cacheExt := fmt.Sprintf("-seq%d-frame%d.png", seqIndex, frameIndex)
	cachedPath := pngCache.GetPath(cacheKey, cacheExt)
	if _, err := os.Stat(cachedPath); err == nil {
		http.ServeFile(w, r, cachedPath)
		return
	}

	// Parse GAF
	bytesReader := bytes.NewReader(data)
	reader, err := gaf.LoadFromReader(bytesReader)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error parsing GAF: %v", err), http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		http.Error(w, fmt.Sprintf("Error reading sequences: %v", err), http.StatusInternalServerError)
		return
	}

	if seqIndex >= len(sequences) {
		http.Error(w, fmt.Sprintf("Sequence index %d out of range (max %d)", seqIndex, len(sequences)-1), http.StatusBadRequest)
		return
	}

	seq := sequences[seqIndex]
	if frameIndex >= len(seq.Frames) {
		http.Error(w, fmt.Sprintf("Frame index %d out of range (max %d)", frameIndex, len(seq.Frames)-1), http.StatusBadRequest)
		return
	}

	// Load palette
	palette := loadPalette()

	// Generate PNG
	var pngBuffer bytes.Buffer
	if err := seq.Frames[frameIndex].ToPNG(palette, &pngBuffer); err != nil {
		http.Error(w, fmt.Sprintf("Error generating PNG: %v", err), http.StatusInternalServerError)
		return
	}

	// Cache it
	pngData := pngBuffer.Bytes()
	tmpPng, err := os.CreateTemp("", "gaf-*.png")
	if err == nil {
		defer func() { _ = os.Remove(tmpPng.Name()) }()
		defer func() { _ = tmpPng.Close() }()
		
		if _, err := tmpPng.Write(pngData); err == nil {
			if err := tmpPng.Close(); err != nil {
				logger.Error("Failed to close temp PNG", zap.Error(err))
			}
			_, _ = pngCache.Put([]byte(cacheKey), cacheExt, tmpPng.Name())
		}
	}

	// Serve it
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=31536000")
	if _, err := w.Write(pngData); err != nil {
		logger.Error("Failed to write PNG response", zap.Error(err))
	}
}

// handleWebAPNG converts GAF sequences to APNG and serves them
func handleWebAPNG(w http.ResponseWriter, r *http.Request) {
	fullPath := strings.TrimPrefix(r.URL.Path, "/apng/")
	
	// Extract sequence index
	// Format: /apng/file.gaf/seqIndex
	parts := strings.Split(fullPath, "/")
	seqIndex := 0

	// Find the .gaf file in the path
	gafIndex := -1
	for i, part := range parts {
		if strings.HasSuffix(strings.ToLower(part), ".gaf") {
			gafIndex = i
			break
		}
	}

	if gafIndex == -1 {
		http.Error(w, "No GAF file found in path", http.StatusBadRequest)
		return
	}

	filePath := strings.Join(parts[:gafIndex+1], "/")

	if gafIndex+1 < len(parts) && parts[gafIndex+1] != "" {
		if idx, err := strconv.Atoi(parts[gafIndex+1]); err == nil {
			seqIndex = idx
		}
	}

	// Read file from VFS
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		http.Error(w, fmt.Sprintf("File not found: %s", filePath), http.StatusNotFound)
		return
	}
	
	// Create cache key
	var cacheKey string
	normalizedPath := strings.ToLower(strings.TrimPrefix(filePath, "/"))
	if md5Hash, ok := vfs.GetMD5(normalizedPath); ok {
		cacheKey = md5Hash
	} else {
		cacheKey = cache.HashData(data)
	}
	
	cacheExt := fmt.Sprintf("-seq%d.apng", seqIndex)
	cachedPath := apngCache.GetPath(cacheKey, cacheExt)
	if _, err := os.Stat(cachedPath); err == nil {
		http.ServeFile(w, r, cachedPath)
		return
	}

	// Parse GAF
	bytesReader := bytes.NewReader(data)
	reader, err := gaf.LoadFromReader(bytesReader)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error parsing GAF: %v", err), http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		http.Error(w, fmt.Sprintf("Error reading sequences: %v", err), http.StatusInternalServerError)
		return
	}

	if seqIndex >= len(sequences) {
		http.Error(w, fmt.Sprintf("Sequence index %d out of range (max %d)", seqIndex, len(sequences)-1), http.StatusBadRequest)
		return
	}

	seq := sequences[seqIndex]

	// Load palette
	palette := loadPalette()

	// Generate APNG
	var apngBuffer bytes.Buffer
	if err := seq.ToAPNG(palette, &apngBuffer); err != nil {
		http.Error(w, fmt.Sprintf("Error generating APNG: %v", err), http.StatusInternalServerError)
		return
	}

	// Cache it
	apngData := apngBuffer.Bytes()
	tmpApng, err := os.CreateTemp("", "gaf-*.apng")
	if err == nil {
		defer func() { _ = os.Remove(tmpApng.Name()) }()
		defer func() { _ = tmpApng.Close() }()
		
		if _, err := tmpApng.Write(apngData); err == nil {
			if err := tmpApng.Close(); err != nil {
				logger.Error("Failed to close temp APNG", zap.Error(err))
			}
			_, _ = apngCache.Put([]byte(cacheKey), cacheExt, tmpApng.Name())
		}
	}

	// Serve it
	w.Header().Set("Content-Type", "image/apng")
	w.Header().Set("Cache-Control", "public, max-age=31536000")
	if _, err := w.Write(apngData); err != nil {
		logger.Error("Failed to write APNG response", zap.Error(err))
	}
}

// clearAllCaches removes all cache directories
func clearAllCaches() error {
	cacheDirs := []string{
		".cache/zrb-mp4",
		".cache/zrb-thumb",
		".cache/sct-png",
		".cache/tnt-png",
		".cache/gaf-gif",
		".cache/gaf-png",
		".cache/gaf-apng",
		".cache/pcx-png",
	}
	
	for _, dir := range cacheDirs {
		if err := os.RemoveAll(dir); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to clear cache %s: %w", dir, err)
		}
	}
	return nil
}
