package explorer

import (
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// ExplorerMetrics holds all metrics for the explorer server
type ExplorerMetrics struct {
	// HTTP request metrics
	BrowseRequests     *prometheus.CounterVec
	FileViewRequests   *prometheus.CounterVec
	RawFileRequests    *prometheus.CounterVec
	DescribeRequests   *prometheus.CounterVec
	
	// Video (Smacker to MP4) cache metrics
	VideoRequestsTotal      prometheus.Counter
	VideoCacheHits          prometheus.Counter
	VideoCacheMisses        prometheus.Counter
	VideoFFmpegGenerations  prometheus.Counter
	VideoConversionsAvoided prometheus.Counter
	
	// GAF to GIF cache metrics
	GIFRequestsTotal      prometheus.Counter
	GIFCacheHits          prometheus.Counter
	GIFCacheMisses        prometheus.Counter
	GIFGenerations        prometheus.Counter
	GIFConversionsAvoided prometheus.Counter
	
	// VFS I/O metrics
	VFSBytesRead     prometheus.Counter
	VFSBytesWritten  prometheus.Counter
	VFSReadOps       prometheus.Counter
	VFSWriteOps      prometheus.Counter
	
	// Cache warmer metrics
	CacheWarmerTotal            prometheus.Gauge
	CacheWarmerProcessed        prometheus.Gauge
	CacheWarmerCached           prometheus.Gauge
	CacheWarmerSkippedPrecached prometheus.Gauge
	CacheWarmerSkippedErrors    *prometheus.GaugeVec  // With reason label
	CacheWarmerErrors           prometheus.Gauge
	
	// Internal atomic counters for tracking (used before VFS metrics are ready)
	vfsBytesRead    *atomic.Int64
	vfsBytesWritten *atomic.Int64
}

// Global metrics instance
var metrics *ExplorerMetrics

// InitMetrics initializes all Prometheus metrics for the explorer
func InitMetrics(registry *prometheus.Registry) *ExplorerMetrics {
	factory := promauto.With(registry)
	
	m := &ExplorerMetrics{
		// HTTP request counters with path labels
		BrowseRequests: factory.NewCounterVec(
			prometheus.CounterOpts{
				Name: "cavedogfs_browse_requests_total",
				Help: "Total number of browse requests by path",
			},
			[]string{"path"},
		),
		FileViewRequests: factory.NewCounterVec(
			prometheus.CounterOpts{
				Name: "cavedogfs_file_view_requests_total",
				Help: "Total number of file view requests by extension",
			},
			[]string{"extension"},
		),
		RawFileRequests: factory.NewCounterVec(
			prometheus.CounterOpts{
				Name: "cavedogfs_raw_file_requests_total",
				Help: "Total number of raw file requests by extension",
			},
			[]string{"extension"},
		),
		DescribeRequests: factory.NewCounterVec(
			prometheus.CounterOpts{
				Name: "cavedogfs_describe_requests_total",
				Help: "Total number of describe/info requests by type",
			},
			[]string{"file_type"},
		),
		
		// Video cache metrics
		VideoRequestsTotal: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_video_requests_total",
				Help: "Total number of video playback requests",
			},
		),
		VideoCacheHits: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_video_cache_hits_total",
				Help: "Total number of video cache hits (served from cache)",
			},
		),
		VideoCacheMisses: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_video_cache_misses_total",
				Help: "Total number of video cache misses (required conversion)",
			},
		),
		VideoFFmpegGenerations: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_video_ffmpeg_generations_total",
				Help: "Total number of FFmpeg conversions performed (SMK to MP4)",
			},
		),
		VideoConversionsAvoided: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_video_conversions_avoided_total",
				Help: "Total number of video conversions avoided due to caching",
			},
		),
		
		// GIF cache metrics
		GIFRequestsTotal: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_gif_requests_total",
				Help: "Total number of GIF animation requests",
			},
		),
		GIFCacheHits: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_gif_cache_hits_total",
				Help: "Total number of GIF cache hits (served from cache)",
			},
		),
		GIFCacheMisses: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_gif_cache_misses_total",
				Help: "Total number of GIF cache misses (required generation)",
			},
		),
		GIFGenerations: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_gif_generations_total",
				Help: "Total number of GIF animations generated from GAF",
			},
		),
		GIFConversionsAvoided: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_gif_conversions_avoided_total",
				Help: "Total number of GIF conversions avoided due to caching",
			},
		),
		
		// VFS I/O metrics
		VFSBytesRead: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_vfs_bytes_read_total",
				Help: "Total number of bytes read from VFS",
			},
		),
		VFSBytesWritten: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_vfs_bytes_written_total",
				Help: "Total number of bytes written to VFS",
			},
		),
		VFSReadOps: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_vfs_read_operations_total",
				Help: "Total number of VFS read operations",
			},
		),
		VFSWriteOps: factory.NewCounter(
			prometheus.CounterOpts{
				Name: "cavedogfs_vfs_write_operations_total",
				Help: "Total number of VFS write operations",
			},
		),
		
		// Cache warmer metrics
		CacheWarmerTotal: factory.NewGauge(
			prometheus.GaugeOpts{
				Name: "cavedogfs_cache_warmer_total_files",
				Help: "Total number of files found for cache warming",
			},
		),
		CacheWarmerProcessed: factory.NewGauge(
			prometheus.GaugeOpts{
				Name: "cavedogfs_cache_warmer_processed_files",
				Help: "Number of files processed by cache warmer",
			},
		),
		CacheWarmerCached: factory.NewGauge(
			prometheus.GaugeOpts{
				Name: "cavedogfs_cache_warmer_cached_files",
				Help: "Number of files successfully cached",
			},
		),
		CacheWarmerSkippedPrecached: factory.NewGauge(
			prometheus.GaugeOpts{
				Name: "cavedogfs_cache_warmer_skipped_precached_files",
				Help: "Number of files skipped because already in cache",
			},
		),
		CacheWarmerSkippedErrors: factory.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "cavedogfs_cache_warmer_skipped_errors_files",
				Help: "Number of files skipped due to errors by reason",
			},
			[]string{"reason"},
		),
		CacheWarmerErrors: factory.NewGauge(
			prometheus.GaugeOpts{
				Name: "cavedogfs_cache_warmer_error_files",
				Help: "Number of files that failed with unexpected errors",
			},
		),
		
		// Initialize atomic counters
		vfsBytesRead:    &atomic.Int64{},
		vfsBytesWritten: &atomic.Int64{},
	}
	
	return m
}

// RecordBrowse records a browse request
func (m *ExplorerMetrics) RecordBrowse(path string) {
	if m != nil && m.BrowseRequests != nil {
		m.BrowseRequests.WithLabelValues(path).Inc()
	}
}

// RecordFileView records a file view request
func (m *ExplorerMetrics) RecordFileView(extension string) {
	if m != nil && m.FileViewRequests != nil {
		m.FileViewRequests.WithLabelValues(extension).Inc()
	}
}

// RecordRawFile records a raw file request
func (m *ExplorerMetrics) RecordRawFile(extension string) {
	if m != nil && m.RawFileRequests != nil {
		m.RawFileRequests.WithLabelValues(extension).Inc()
	}
}

// RecordDescribe records a describe/info request
func (m *ExplorerMetrics) RecordDescribe(fileType string) {
	if m != nil && m.DescribeRequests != nil {
		m.DescribeRequests.WithLabelValues(fileType).Inc()
	}
}

// RecordVideoRequest records a video playback request
func (m *ExplorerMetrics) RecordVideoRequest() {
	if m != nil && m.VideoRequestsTotal != nil {
		m.VideoRequestsTotal.Inc()
	}
}

// RecordVideoCacheHit records a video cache hit
func (m *ExplorerMetrics) RecordVideoCacheHit() {
	if m != nil {
		m.VideoCacheHits.Inc()
		m.VideoConversionsAvoided.Inc()
	}
}

// RecordVideoCacheMiss records a video cache miss
func (m *ExplorerMetrics) RecordVideoCacheMiss() {
	if m != nil && m.VideoCacheMisses != nil {
		m.VideoCacheMisses.Inc()
	}
}

// RecordVideoGeneration records an FFmpeg video generation
func (m *ExplorerMetrics) RecordVideoGeneration() {
	if m != nil && m.VideoFFmpegGenerations != nil {
		m.VideoFFmpegGenerations.Inc()
	}
}

// RecordGIFRequest records a GIF animation request
func (m *ExplorerMetrics) RecordGIFRequest() {
	if m != nil && m.GIFRequestsTotal != nil {
		m.GIFRequestsTotal.Inc()
	}
}

// RecordGIFCacheHit records a GIF cache hit
func (m *ExplorerMetrics) RecordGIFCacheHit() {
	if m != nil {
		m.GIFCacheHits.Inc()
		m.GIFConversionsAvoided.Inc()
	}
}

// RecordGIFCacheMiss records a GIF cache miss
func (m *ExplorerMetrics) RecordGIFCacheMiss() {
	if m != nil && m.GIFCacheMisses != nil {
		m.GIFCacheMisses.Inc()
	}
}

// RecordGIFGeneration records a GIF generation
func (m *ExplorerMetrics) RecordGIFGeneration() {
	if m != nil && m.GIFGenerations != nil {
		m.GIFGenerations.Inc()
	}
}

// RecordVFSRead records VFS read operation
func (m *ExplorerMetrics) RecordVFSRead(bytes int64) {
	if m != nil {
		if m.VFSBytesRead != nil {
			m.VFSBytesRead.Add(float64(bytes))
		}
		if m.VFSReadOps != nil {
			m.VFSReadOps.Inc()
		}
		if m.vfsBytesRead != nil {
			m.vfsBytesRead.Add(bytes)
		}
	}
}

// RecordVFSWrite records VFS write operation
func (m *ExplorerMetrics) RecordVFSWrite(bytes int64) {
	if m != nil {
		if m.VFSBytesWritten != nil {
			m.VFSBytesWritten.Add(float64(bytes))
		}
		if m.VFSWriteOps != nil {
			m.VFSWriteOps.Inc()
		}
		if m.vfsBytesWritten != nil {
			m.vfsBytesWritten.Add(bytes)
		}
	}
}

// UpdateCacheWarmerProgress updates cache warmer metrics
func (m *ExplorerMetrics) UpdateCacheWarmerProgress(progress map[string]int64, errorReasons map[string]int64) {
	if m != nil {
		if m.CacheWarmerTotal != nil {
			m.CacheWarmerTotal.Set(float64(progress["total"]))
		}
		if m.CacheWarmerProcessed != nil {
			m.CacheWarmerProcessed.Set(float64(progress["processed"]))
		}
		if m.CacheWarmerCached != nil {
			m.CacheWarmerCached.Set(float64(progress["cached"]))
		}
		if m.CacheWarmerSkippedPrecached != nil {
			m.CacheWarmerSkippedPrecached.Set(float64(progress["skipped_precached"]))
		}
		if m.CacheWarmerSkippedErrors != nil {
			// Update metrics for each error reason
			for reason, count := range errorReasons {
				m.CacheWarmerSkippedErrors.WithLabelValues(reason).Set(float64(count))
			}
		}
		if m.CacheWarmerErrors != nil {
			m.CacheWarmerErrors.Set(float64(progress["errors"]))
		}
	}
}
