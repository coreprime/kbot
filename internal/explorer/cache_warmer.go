package explorer

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"runtime"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coreprime/kbot/internal/cache"
	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/smacker"
	"go.uber.org/zap"
)

// CacheWarmerConfig holds configuration for the cache warming service
type CacheWarmerConfig struct {
	Enabled          bool          // Enable/disable cache warming
	WorkerCount      int           // Number of parallel workers
	MaxFileSizeMB    int           // Maximum file size to cache (MB)
	ScanInterval     time.Duration // How often to rescan (0 = scan once)
	PrioritizeSmall  bool          // Process small files first
	VideoEnabled     bool          // Enable video cache warming
	GIFEnabled       bool          // Enable GIF cache warming
	MaxVideoDuration int           // Max video duration in seconds (0 = unlimited)
	SkipFiles        []string      // File paths to skip during warming
}

// DefaultCacheWarmerConfig returns sensible defaults
func DefaultCacheWarmerConfig() *CacheWarmerConfig {
	return &CacheWarmerConfig{
		Enabled:          true,
		WorkerCount:      max(runtime.GOMAXPROCS(0)-1, 1),
		MaxFileSizeMB:    50,
		ScanInterval:     0, // Scan once on startup
		PrioritizeSmall:  true,
		VideoEnabled:     true,
		GIFEnabled:       true,
		MaxVideoDuration: 60,
		SkipFiles: []string{
			"palettes/guipal.pcx", // Not a valid PCX file (manufacturer byte 0x00)
		},
	}
}

// CacheWarmer manages background cache generation
type CacheWarmer struct {
	config      *CacheWarmerConfig
	vfs         *filesystem.VirtualFileSystem
	videoCache  *cache.Cache
	gifCache    *cache.Cache
	pngCache    *cache.Cache  // For GAF frame PNGs
	apngCache   *cache.Cache  // For GAF sequence APNGs
	pcxPngCache  *cache.Cache  // For PCX to PNG conversion
	zrbThumbCch  *cache.Cache  // For ZRB/SMK video thumbnails
	sctCch       *cache.Cache  // For SCT tile map PNGs
	tntCch       *cache.Cache  // For TNT minimap PNGs
	ctx          context.Context
	cancel      context.CancelFunc
	wg         sync.WaitGroup
	logger     *zap.Logger

	// Progress tracking
	totalFiles       atomic.Int64
	processedFiles   atomic.Int64
	skippedPrecached atomic.Int64 // Files skipped because already in cache
	skippedErrors    atomic.Int64 // Files skipped due to errors (EOF, corrupt, etc.)
	errorFiles       atomic.Int64 // Unexpected errors
	cachedFiles      atomic.Int64
	videosCached     atomic.Int64
	gifsCached       atomic.Int64
	
	// Error tracking by reason
	errorReasons map[string]*atomic.Int64
	errorMutex   sync.RWMutex

	// Metrics integration
	metrics *ExplorerMetrics

	// Event broadcasting for live progress updates.
	eventMu     sync.Mutex
	eventSubs   map[chan CacheEvent]struct{}

	// Active worker state for SSE reconnect.
	workerState   []CacheEvent // one per worker
	workerStateMu sync.RWMutex
	warming       atomic.Bool
}

// CacheEvent is a progress update sent to SSE clients.
type CacheEvent struct {
	Type      string `json:"type"`      // "worker-start", "worker-done", "progress", "done"
	Worker    int    `json:"worker"`    // worker ID (0-based)
	File      string `json:"file"`      // current file being processed
	FileType  string `json:"fileType"`  // "video", "gaf", "pcx", "sct", "tnt"
	Total     int64  `json:"total"`
	Processed int64  `json:"processed"`
	Cached    int64  `json:"cached"`
	Skipped   int64  `json:"skipped"`
	Workers   int    `json:"workers"`   // total number of workers
}

// Subscribe returns a channel that receives cache warming events.
func (cw *CacheWarmer) Subscribe() chan CacheEvent {
	ch := make(chan CacheEvent, 32)
	cw.eventMu.Lock()
	cw.eventSubs[ch] = struct{}{}
	cw.eventMu.Unlock()
	return ch
}

// Unsubscribe removes an event channel.
func (cw *CacheWarmer) Unsubscribe(ch chan CacheEvent) {
	cw.eventMu.Lock()
	delete(cw.eventSubs, ch)
	cw.eventMu.Unlock()
	close(ch)
}

func (cw *CacheWarmer) broadcast(evt CacheEvent) {
	// Track worker state for reconnecting clients.
	if evt.Type == "worker-start" || evt.Type == "worker-done" {
		cw.workerStateMu.Lock()
		if evt.Worker >= 0 && evt.Worker < len(cw.workerState) {
			cw.workerState[evt.Worker] = evt
		}
		cw.workerStateMu.Unlock()
	}
	if evt.Type == "done" {
		cw.warming.Store(false)
	}

	cw.eventMu.Lock()
	defer cw.eventMu.Unlock()
	for ch := range cw.eventSubs {
		select {
		case ch <- evt:
		default:
		}
	}
}

// IsWarming returns true if cache warming is in progress.
func (cw *CacheWarmer) IsWarming() bool {
	return cw.warming.Load()
}

// GetWorkerStates returns the current state of all workers.
func (cw *CacheWarmer) GetWorkerStates() []CacheEvent {
	cw.workerStateMu.RLock()
	defer cw.workerStateMu.RUnlock()
	out := make([]CacheEvent, len(cw.workerState))
	copy(out, cw.workerState)
	return out
}

// cacheableFile represents a file that needs caching
type cacheableFile struct {
	path     string
	size     int64
	fileType string // "video" or "gaf"
}

// calculateProgress calculates cache warming progress percentage
func calculateProgress(progress map[string]int64) float64 {
	total := progress["total"]
	if total == 0 {
		return 0.0
	}
	return float64(progress["processed"]) / float64(total) * 100.0
}

// NewCacheWarmer creates a new cache warming service
func NewCacheWarmer(
	config *CacheWarmerConfig,
	vfs *filesystem.VirtualFileSystem,
	videoCache *cache.Cache,
	gifCache *cache.Cache,
	pngCache *cache.Cache,
	apngCache *cache.Cache,
	pcxPngCache *cache.Cache,
	zrbThumbCch *cache.Cache,
	sctCch *cache.Cache,
	tntCch *cache.Cache,
	metrics *ExplorerMetrics,
	logger *zap.Logger,
) *CacheWarmer {
	ctx, cancel := context.WithCancel(context.Background())

	return &CacheWarmer{
		config:       config,
		vfs:          vfs,
		videoCache:   videoCache,
		gifCache:     gifCache,
		pngCache:     pngCache,
		apngCache:    apngCache,
		pcxPngCache:  pcxPngCache,
		zrbThumbCch:  zrbThumbCch,
		sctCch:       sctCch,
		tntCch:       tntCch,
		ctx:          ctx,
		cancel:       cancel,
		metrics:      metrics,
		logger:       logger,
		errorReasons: make(map[string]*atomic.Int64),
		eventSubs:    make(map[chan CacheEvent]struct{}),
		workerState:  make([]CacheEvent, config.WorkerCount),
	}
}

// Start begins the cache warming process
func (cw *CacheWarmer) Start() {
	if !cw.config.Enabled {
		cw.logger.Info("Cache warming is disabled")
		return
	}

	cw.logger.Info("Starting cache warmer",
		zap.Int("workers", cw.config.WorkerCount),
		zap.Int("max_file_size_mb", cw.config.MaxFileSizeMB))

	cw.wg.Add(1)
	go cw.run()
}

// Stop gracefully stops the cache warmer
func (cw *CacheWarmer) Stop() {
	cw.logger.Info("Stopping cache warmer")
	cw.cancel()
	cw.wg.Wait()
	cw.logger.Info("Cache warmer stopped")
}

// GetProgress returns current progress statistics
func (cw *CacheWarmer) GetProgress() map[string]int64 {
	return map[string]int64{
		"total":             cw.totalFiles.Load(),
		"processed":         cw.processedFiles.Load(),
		"skipped_precached": cw.skippedPrecached.Load(),
		"skipped_errors":    cw.skippedErrors.Load(),
		"errors":            cw.errorFiles.Load(),
		"cached":            cw.cachedFiles.Load(),
		"videos":            cw.videosCached.Load(),
		"gifs":              cw.gifsCached.Load(),
	}
}

// GetErrorReasons returns error counts by reason
func (cw *CacheWarmer) GetErrorReasons() map[string]int64 {
	cw.errorMutex.RLock()
	defer cw.errorMutex.RUnlock()
	
	reasons := make(map[string]int64)
	for reason, counter := range cw.errorReasons {
		reasons[reason] = counter.Load()
	}
	return reasons
}

// categorizeError returns a standardized reason code for an error
func categorizeError(errMsg string) string {
	if strings.Contains(errMsg, "EOF") || strings.Contains(errMsg, "truncated") {
		return "truncated"
	} else if strings.Contains(errMsg, "layer") {
		return "invalid_layer"
	} else if strings.Contains(errMsg, "unsupported") {
		return "unsupported_format"
	} else if strings.Contains(errMsg, "corrupt") {
		return "corrupted"
	} else if strings.Contains(errMsg, "no sequences") {
		return "empty_file"
	}
	return "other"
}

// incrementErrorReason safely increments the counter for a given reason
func (cw *CacheWarmer) incrementErrorReason(reason string) {
	cw.errorMutex.Lock()
	defer cw.errorMutex.Unlock()
	
	if _, exists := cw.errorReasons[reason]; !exists {
		cw.errorReasons[reason] = &atomic.Int64{}
	}
	cw.errorReasons[reason].Add(1)
}

// run is the main loop
func (cw *CacheWarmer) run() {
	defer cw.wg.Done()

	// Initial scan and warm
	cw.scanAndWarm()

	// If scan interval is set, keep rescanning
	if cw.config.ScanInterval > 0 {
		ticker := time.NewTicker(cw.config.ScanInterval)
		defer ticker.Stop()

		for {
			select {
			case <-cw.ctx.Done():
				return
			case <-ticker.C:
				cw.scanAndWarm()
			}
		}
	}
}

// scanAndWarm scans VFS and warms caches
func (cw *CacheWarmer) scanAndWarm() {
	startTime := time.Now()
	cw.warming.Store(true)
	cw.logger.Info("Starting cache warming scan")

	// Scan VFS for cacheable files
	files := cw.scanVFS()
	cw.totalFiles.Store(int64(len(files)))

	cw.logger.Info("Found cacheable files", zap.Int("count", len(files)))

	if len(files) == 0 {
		return
	}

	// Sort: non-video files first (fast), then videos (slow FFmpeg).
	// Within each group, smallest first.
	sort.Slice(files, func(i, j int) bool {
		iVideo := files[i].fileType == "video"
		jVideo := files[j].fileType == "video"
		if iVideo != jVideo {
			return !iVideo // non-video before video
		}
		return files[i].size < files[j].size
	})

	// Create worker pool
	workQueue := make(chan cacheableFile, 100)

	// Start workers with a separate wait group
	var workerWg sync.WaitGroup
	for i := 0; i < cw.config.WorkerCount; i++ {
		workerWg.Add(1)
		go cw.worker(i, workQueue, &workerWg)
	}

	// Feed work to queue
	for _, file := range files {
		select {
		case <-cw.ctx.Done():
			close(workQueue)
			return
		case workQueue <- file:
		}
	}

	close(workQueue)

	// Start progress reporter
	progressTicker := time.NewTicker(5 * time.Second)
	defer progressTicker.Stop()

	progressDone := make(chan struct{})
	go func() {
		for {
			select {
			case <-progressDone:
				return
			case <-progressTicker.C:
				progress := cw.GetProgress()
				errorReasons := cw.GetErrorReasons()
				if cw.metrics != nil {
					cw.metrics.UpdateCacheWarmerProgress(progress, errorReasons)
				}
				cw.logger.Info("Cache warming progress",
					zap.Int64("processed", progress["processed"]),
					zap.Int64("total", progress["total"]),
					zap.Float64("percent", calculateProgress(progress)),
					zap.Int64("cached", progress["cached"]),
					zap.Int64("skipped_errors", progress["skipped_errors"]),
					zap.Int64("errors", progress["errors"]))
			}
		}
	}()

	// Wait for workers to finish (but use context for cancellation)
	done := make(chan struct{})
	go func() {
		workerWg.Wait()
		close(done)
	}()

	select {
	case <-cw.ctx.Done():
		close(progressDone)
		cw.logger.Warn("Cache warming cancelled during processing")
	case <-done:
		close(progressDone)
		elapsed := time.Since(startTime)

		// Final metrics update
		progress := cw.GetProgress()
		errorReasons := cw.GetErrorReasons()
		if cw.metrics != nil {
			cw.metrics.UpdateCacheWarmerProgress(progress, errorReasons)
		}

		cw.broadcast(CacheEvent{
			Type:      "done",
			Total:     cw.totalFiles.Load(),
			Processed: cw.processedFiles.Load(),
			Cached:    cw.cachedFiles.Load(),
			Skipped:   cw.skippedPrecached.Load() + cw.skippedErrors.Load(),
			Workers:   cw.config.WorkerCount,
		})

		cw.logger.Info("Cache warming completed",
			zap.Duration("elapsed", elapsed),
			zap.Int64("processed", cw.processedFiles.Load()),
			zap.Int64("cached", cw.cachedFiles.Load()),
			zap.Int64("skipped_precached", cw.skippedPrecached.Load()),
			zap.Int64("skipped_errors", cw.skippedErrors.Load()),
			zap.Int64("errors", cw.errorFiles.Load()))

		// Explain skipped_errors if any with breakdown by reason
		if cw.skippedErrors.Load() > 0 {
			errorReasons := cw.GetErrorReasons()
			
			// Create zap fields for each reason
			reasonFields := []zap.Field{
				zap.Int64("total_skipped", cw.skippedErrors.Load()),
			}
			for reason, count := range errorReasons {
				reasonFields = append(reasonFields, zap.Int64(reason, count))
			}
			reasonFields = append(reasonFields,
				zap.String("impact", "these files are still accessible via on-demand conversion"),
				zap.String("note", "use debug logging to see individual file details"))
			
			cw.logger.Info("Files skipped due to known errors", reasonFields...)
		}

		cw.logger.Info("Cache statistics",
			zap.Int64("videos_cached", cw.videosCached.Load()),
			zap.Int64("gifs_cached", cw.gifsCached.Load()))
	}
}

// scanVFS scans the VFS for cacheable files
func (cw *CacheWarmer) scanVFS() []cacheableFile {
	var files []cacheableFile
	var mu sync.Mutex

	// Get all files from VFS stats
	stats := cw.vfs.Stats()

	// Walk all directories
	cw.walkDirectory("", &files, &mu)

	cw.logger.Debug("VFS scan completed", zap.Any("stats", stats))

	return files
}

// walkDirectory recursively walks directories
func (cw *CacheWarmer) walkDirectory(dir string, files *[]cacheableFile, mu *sync.Mutex) {
	entries, err := cw.vfs.ListDir(dir)
	if err != nil {
		return
	}

	for _, entryName := range entries {
		fullPath := entryName
		if dir != "" {
			fullPath = filepath.Join(dir, entryName)
		}

		// Get file info
		info, err := cw.vfs.Stat(fullPath)
		if err != nil {
			continue
		}

		if info.IsDir {
			// Recurse into directory
			cw.walkDirectory(fullPath, files, mu)
		} else {
			ext := strings.ToLower(filepath.Ext(entryName))

			// Skip known problematic files.
			skip := false
			for _, sf := range cw.config.SkipFiles {
				if strings.EqualFold(fullPath, sf) {
					skip = true
					break
				}
			}
			if skip {
				continue
			}

			// Skip files over size limit
			maxBytes := int64(cw.config.MaxFileSizeMB) * 1024 * 1024
			if info.Size > maxBytes {
				continue
			}

			var fileType string
			if (ext == ".smk" || ext == ".zrb") && cw.config.VideoEnabled {
				fileType = "video"
			} else if ext == ".gaf" && cw.config.GIFEnabled {
				fileType = "gaf"
			} else if ext == ".pcx" {
				fileType = "pcx"
			} else if ext == ".sct" {
				fileType = "sct"
			} else if ext == ".tnt" {
				fileType = "tnt"
			} else {
				continue
			}

			mu.Lock()
			*files = append(*files, cacheableFile{
				path:     fullPath,
				size:     info.Size,
				fileType: fileType,
			})
			mu.Unlock()
		}
	}
}

// worker processes files from the queue
func (cw *CacheWarmer) worker(id int, workQueue <-chan cacheableFile, wg *sync.WaitGroup) {
	defer wg.Done()

	for file := range workQueue {
		select {
		case <-cw.ctx.Done():
			return
		default:
		}

		// Broadcast worker start.
		cw.broadcast(CacheEvent{
			Type:      "worker-start",
			Worker:    id,
			File:      file.path,
			FileType:  file.fileType,
			Total:     cw.totalFiles.Load(),
			Processed: cw.processedFiles.Load(),
			Workers:   cw.config.WorkerCount,
		})

		var err error
		switch file.fileType {
		case "video":
			err = cw.warmVideoCache(file)
			if err == nil {
				thumbErr := cw.warmZRBThumbCache(file)
				if thumbErr != nil {
					cw.logger.Debug("ZRB thumb warm failed", zap.String("file", file.path), zap.Error(thumbErr))
				}
			}
		case "gaf":
			err = cw.warmGAFCache(file)
		case "pcx":
			err = cw.warmPCXCache(file)
		case "sct":
			err = cw.warmSCTCache(file)
		case "tnt":
			err = cw.warmTNTCache(file)
		}

		cw.processedFiles.Add(1)
		cw.broadcast(CacheEvent{
			Type:      "worker-done",
			Worker:    id,
			File:      file.path,
			FileType:  file.fileType,
			Total:     cw.totalFiles.Load(),
			Processed: cw.processedFiles.Load(),
			Cached:    cw.cachedFiles.Load(),
			Skipped:   cw.skippedPrecached.Load() + cw.skippedErrors.Load(),
			Workers:   cw.config.WorkerCount,
		})

		if err != nil {
			errMsg := err.Error()
			if strings.Contains(errMsg, "EOF") ||
				strings.Contains(errMsg, "layer") ||
				strings.Contains(errMsg, "truncated") ||
				strings.Contains(errMsg, "corrupt") ||
				strings.Contains(errMsg, "unsupported") ||
				strings.Contains(errMsg, "no sequences") {
				// Known errors - categorize and track
				cw.skippedErrors.Add(1)
				
				// Get standardized reason code
				reasonCode := categorizeError(errMsg)
				cw.incrementErrorReason(reasonCode)

				// Determine human-readable reason for logging
				var reasonDesc string
				switch reasonCode {
				case "truncated":
					reasonDesc = "truncated file data (incomplete extraction or corruption)"
				case "invalid_layer":
					reasonDesc = "invalid layer structure (malformed GAF format)"
				case "unsupported_format":
					reasonDesc = "unsupported format version or encoding"
				case "corrupted":
					reasonDesc = "corrupted file data"
				case "empty_file":
					reasonDesc = "empty file with no animation sequences"
				default:
					reasonDesc = "known file format issue"
				}

				cw.logger.Debug("Skipped file due to known error",
					zap.String("file", file.path),
					zap.String("reason", reasonDesc),
					zap.String("reason_code", reasonCode),
					zap.String("error", errMsg))
			} else {
				// Log unexpected errors
				cw.logger.Error("Worker error processing file",
					zap.Int("worker_id", id),
					zap.String("file", file.path),
					zap.Error(err))
				cw.errorFiles.Add(1)
			}
		}
	}
}

// warmVideoCache pre-generates video cache
func (cw *CacheWarmer) warmVideoCache(file cacheableFile) error {
	// Read file data
	data, err := cw.vfs.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	// Check video duration if limit is set
	if cw.config.MaxVideoDuration > 0 {
		// Parse Smacker header to get duration
		// For now, we'll skip very large files as they're likely long videos
		// This is a heuristic - proper duration check would require parsing the header
		if file.size > 64*1024*1024 { // > 64MB, likely long video
			return fmt.Errorf("file too large, skipping")
		}
	}

	// Create temp file for source
	tmpSmk, err := os.CreateTemp("", "warmcache-*.smk")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpSmkPath := tmpSmk.Name()
	defer func() {
		_ = os.Remove(tmpSmkPath)
	}()

	if _, err := tmpSmk.Write(data); err != nil {
		_ = tmpSmk.Close()
		return fmt.Errorf("failed to write temp file: %w", err)
	}
	if err := tmpSmk.Close(); err != nil {
		return fmt.Errorf("failed to close temp file: %w", err)
	}

	// Create temp file for output
	tmpMp4 := tmpSmkPath + ".mp4"
	defer func() {
		_ = os.Remove(tmpMp4)
	}()

	// Convert
	if err := smacker.ConvertToMP4(tmpSmkPath, tmpMp4); err != nil {
		return fmt.Errorf("conversion failed: %w", err)
	}

	// Cache the result
	if _, err := cw.videoCache.Put(data, ".mp4", tmpMp4); err != nil {
		return fmt.Errorf("failed to cache: %w", err)
	}

	cw.cachedFiles.Add(1)
	cw.videosCached.Add(1)

	// Update metrics
	if cw.metrics != nil {
		cw.metrics.RecordVideoGeneration()
	}

	return nil
}

// warmZRBThumbCache pre-generates animated APNG thumbnails for ZRB/SMK files.
func (cw *CacheWarmer) warmZRBThumbCache(file cacheableFile) error {
	data, err := cw.vfs.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	thumbPath, err := generateZRBThumb(data)
	if err != nil {
		return fmt.Errorf("thumbnail generation failed: %w", err)
	}
	defer func() { _ = os.Remove(thumbPath) }()

	if _, err := cw.zrbThumbCch.Put(data, ".apng", thumbPath); err != nil {
		return fmt.Errorf("failed to cache thumbnail: %w", err)
	}

	return nil
}

// warmTNTCache pre-generates minimap PNG for TNT map files.
// cacheImage renders an image and stores it in the cache.
func cacheImage(c *cache.Cache, data []byte, ext string, img image.Image) error {
	tmpFile, err := os.CreateTemp("", "cache-warm-*.png")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmpFile.Name()) }()

	if err := png.Encode(tmpFile, img); err != nil {
		_ = tmpFile.Close()
		return err
	}
	_ = tmpFile.Close()

	_, err = c.Put(data, ext, tmpFile.Name())
	return err
}

// warmTNTCache pre-generates minimap, tilemap, heightmap, and tile PNGs.
func (cw *CacheWarmer) warmTNTCache(file cacheableFile) error {
	data, err := cw.vfs.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	m, parseErr := tnt.LoadFromReader(bytes.NewReader(data))
	if parseErr != nil {
		return fmt.Errorf("failed to parse TNT: %w", parseErr)
	}

	pal := loadVFSPalette()
	if pal == nil {
		return fmt.Errorf("no palette available")
	}

	// Minimap
	if img := m.RenderMinimap(pal); img != nil {
		if err := cacheImage(cw.tntCch, data, ".minimap.png", img); err != nil {
			cw.logger.Debug("TNT minimap cache failed", zap.String("file", file.path), zap.Error(err))
		}
	}

	// Full tile map
	if img := m.RenderTileMap(pal); img != nil {
		if err := cacheImage(cw.tntCch, data, ".tilemap.png", img); err != nil {
			cw.logger.Debug("TNT tilemap cache failed", zap.String("file", file.path), zap.Error(err))
		}
	}

	// Height map
	if img := m.RenderHeightMap(); img != nil {
		if err := cacheImage(cw.tntCch, data, ".heightmap.png", img); err != nil {
			cw.logger.Debug("TNT heightmap cache failed", zap.String("file", file.path), zap.Error(err))
		}
	}

	// Individual TNT tiles are cached lazily on request, not during warming.

	cw.cachedFiles.Add(1)
	return nil
}

// warmSCTCache pre-generates tilemap, heightmap, minimap, and tile PNGs.
func (cw *CacheWarmer) warmSCTCache(file cacheableFile) error {
	data, err := cw.vfs.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	section, parseErr := sct.LoadFromReader(bytes.NewReader(data))
	if parseErr != nil {
		return fmt.Errorf("failed to parse SCT: %w", parseErr)
	}

	pal := loadVFSPalette()
	if pal == nil {
		return fmt.Errorf("no palette available")
	}

	// Full tile map
	if img := section.RenderTileMap(pal); img != nil {
		if err := cacheImage(cw.sctCch, data, ".tilemap.png", img); err != nil {
			cw.logger.Debug("SCT tilemap cache failed", zap.String("file", file.path), zap.Error(err))
		}
	}

	// Height map
	if img := section.RenderHeightMap(); img != nil {
		if err := cacheImage(cw.sctCch, data, ".heightmap.png", img); err != nil {
			cw.logger.Debug("SCT heightmap cache failed", zap.String("file", file.path), zap.Error(err))
		}
	}

	// Minimap
	if img := section.RenderMinimap(pal); img != nil {
		if err := cacheImage(cw.sctCch, data, ".minimap.png", img); err != nil {
			cw.logger.Debug("SCT minimap cache failed", zap.String("file", file.path), zap.Error(err))
		}
	}

	// Individual tiles (up to 512)
	maxTiles := len(section.Tiles)
	if maxTiles > 512 {
		maxTiles = 512
	}
	for i := 0; i < maxTiles; i++ {
		tileImg := renderTile32(section.Tiles[i], pal)
		ext := fmt.Sprintf(".tile%d.png", i)
		_ = cacheImage(cw.sctCch, data, ext, tileImg)
	}

	cw.cachedFiles.Add(1)
	return nil
}

// warmGAFCache pre-generates GIF cache for all sequences
func (cw *CacheWarmer) warmGAFCache(file cacheableFile) error {
	// Read file data
	data, err := cw.vfs.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	// Parse GAF file
	gafReader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("failed to create GAF reader: %w", err)
	}
	defer func() {
		_ = gafReader.Close()
	}()

	sequences, err := gafReader.ReadSequences()
	if err != nil {
		return fmt.Errorf("failed to read GAF sequences: %w", err)
	}

	// Get or calculate hash for cache key
	var hash string
	if md5Hash, ok := cw.vfs.GetMD5(file.path); ok {
		hash = md5Hash
	} else {
		hash = cache.HashData(data)
	}

	cachedCount := 0
	skippedCount := 0

	// If no sequences, this is an error (empty/invalid GAF)
	if len(sequences) == 0 {
		return fmt.Errorf("no sequences in GAF file")
	}

	// Load palette (shared across all sequences)
	palette := loadPalette()
	if palette == nil {
		return fmt.Errorf("failed to load palette")
	}

	// Generate GIF for each sequence
	for seqIdx, seq := range sequences {
		if len(seq.Frames) == 0 {
			skippedCount++
			continue
		}

		// Cache key for this sequence
		cacheKey := hash
		cacheExt := fmt.Sprintf("-seq%d.gif", seqIdx)
		cachedPath := cw.gifCache.GetPath(cacheKey, cacheExt)

		// Generate GIF to buffer
		var gifBuffer bytes.Buffer
		if err := seq.WriteGIF(&gifBuffer, palette); err != nil {
			cw.logger.Debug("Failed to generate GIF",
				zap.String("file", file.path),
				zap.Int("sequence", seqIdx),
				zap.Error(err))
			continue
		}

		// Write to temp file
		tmpGif, err := os.CreateTemp("", fmt.Sprintf("warmcache-%s-seq%d-*.gif", hash[:8], seqIdx))
		if err != nil {
			cw.logger.Error("Failed to create temp file", zap.Error(err))
			continue
		}
		tmpPath := tmpGif.Name()

		if _, err := io.Copy(tmpGif, &gifBuffer); err != nil {
			_ = tmpGif.Close()
			_ = os.Remove(tmpPath)
			cw.logger.Error("Failed to write temp file", zap.Error(err))
			continue
		}
		if err := tmpGif.Close(); err != nil {
			_ = os.Remove(tmpPath)
			cw.logger.Error("Failed to close temp file", zap.Error(err))
			continue
		}

		// Move to cache
		if err := os.MkdirAll(filepath.Dir(cachedPath), 0755); err != nil {
			_ = os.Remove(tmpPath)
			cw.logger.Error("Failed to create cache directory", zap.Error(err))
			continue
		}

		if err := os.Rename(tmpPath, cachedPath); err != nil {
			_ = os.Remove(tmpPath)
			cw.logger.Error("Failed to move file to cache", zap.Error(err))
			continue
		}

		cachedCount++

		// Update metrics
		if cw.metrics != nil {
			cw.metrics.RecordGIFGeneration()
		}
	}

	// Also warm PNG and APNG caches
	cw.warmPNGAPNGFiles(sequences, hash, palette)
	
	if cachedCount > 0 {
		cw.cachedFiles.Add(1)
		cw.gifsCached.Add(int64(cachedCount))
		return nil
	}

	if cachedCount == 0 && skippedCount == 0 {
		return fmt.Errorf("no sequences cached")
	}
	return nil
}

// warmPNGAPNGFiles generates PNG and APNG files for GAF sequences
func (cw *CacheWarmer) warmPNGAPNGFiles(sequences []*gaf.Sequence, hash string, palette *gaf.Palette) {
	for seqIdx, seq := range sequences {
		if len(seq.Frames) == 0 {
			continue
		}
		
		// Cache APNG (animated sequence)
		apngExt := fmt.Sprintf("-seq%d.apng", seqIdx)
		apngPath := cw.apngCache.GetPath(hash, apngExt)
		if _, err := os.Stat(apngPath); err != nil {
			var buf bytes.Buffer
			if seq.ToAPNG(palette, &buf) == nil {
				if tmpFile, err := os.CreateTemp("", "warmcache-*.apng"); err == nil {
					tmpPath := tmpFile.Name()
					if _, err := tmpFile.Write(buf.Bytes()); err == nil && tmpFile.Close() == nil {
						_ = os.MkdirAll(filepath.Dir(apngPath), 0755)
						if os.Rename(tmpPath, apngPath) != nil {
							_ = os.Remove(tmpPath)
						}
					} else {
						_ = tmpFile.Close()
						_ = os.Remove(tmpPath)
					}
				}
			}
		}
		
		// Cache PNG for each frame
		for frameIdx, frame := range seq.Frames {
			pngExt := fmt.Sprintf("-seq%d-frame%d.png", seqIdx, frameIdx)
			pngPath := cw.pngCache.GetPath(hash, pngExt)
			if _, err := os.Stat(pngPath); err != nil {
				var buf bytes.Buffer
				if frame.ToPNG(palette, &buf) == nil {
					if tmpFile, err := os.CreateTemp("", "warmcache-*.png"); err == nil {
						tmpPath := tmpFile.Name()
						if _, err := tmpFile.Write(buf.Bytes()); err == nil && tmpFile.Close() == nil {
							_ = os.MkdirAll(filepath.Dir(pngPath), 0755)
							if os.Rename(tmpPath, pngPath) != nil {
								_ = os.Remove(tmpPath)
							}
						} else {
							_ = tmpFile.Close()
							_ = os.Remove(tmpPath)
						}
					}
				}
			}
		}
	}
}

// warmPCXCache generates PNG files for PCX images
func (cw *CacheWarmer) warmPCXCache(file cacheableFile) error {
	data, err := cw.vfs.ReadFile(file.path)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	pcxReader, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("failed to open PCX: %w", err)
	}

	img, err := pcxReader.Decode()
	if err != nil {
		return fmt.Errorf("failed to decode PCX: %w", err)
	}

	if err := cacheImage(cw.pcxPngCache, data, ".png", img); err != nil {
		return err
	}

	cw.cachedFiles.Add(1)
	return nil
}
