package explorer

import (
	"sync/atomic"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func TestMetricsInitialization(t *testing.T) {
	registry := prometheus.NewRegistry()
	m := InitMetrics(registry)

	if m == nil {
		t.Fatal("InitMetrics returned nil")
	}

	// Verify all counters are initialized
	if m.BrowseRequests == nil {
		t.Error("BrowseRequests counter not initialized")
	}
	if m.VideoRequestsTotal == nil {
		t.Error("VideoRequestsTotal counter not initialized")
	}
	if m.GIFRequestsTotal == nil {
		t.Error("GIFRequestsTotal counter not initialized")
	}
	if m.VFSBytesRead == nil {
		t.Error("VFSBytesRead counter not initialized")
	}
}

func TestMetricsRecording(t *testing.T) {
	registry := prometheus.NewRegistry()
	m := InitMetrics(registry)

	// Test browse metrics
	m.RecordBrowse("/units")
	m.RecordBrowse("/textures")

	// Test video metrics
	m.RecordVideoRequest()
	m.RecordVideoCacheHit()
	m.RecordVideoCacheMiss()
	m.RecordVideoGeneration()

	// Test GIF metrics
	m.RecordGIFRequest()
	m.RecordGIFCacheHit()
	m.RecordGIFCacheMiss()
	m.RecordGIFGeneration()

	// Test VFS I/O metrics
	m.RecordVFSRead(1024)
	m.RecordVFSRead(2048)
	m.RecordVFSWrite(512)

	// Verify atomic counters
	if m.vfsBytesRead.Load() != 1024+2048 {
		t.Errorf("Expected vfsBytesRead to be %d, got %d", 1024+2048, m.vfsBytesRead.Load())
	}
	if m.vfsBytesWritten.Load() != 512 {
		t.Errorf("Expected vfsBytesWritten to be 512, got %d", m.vfsBytesWritten.Load())
	}

	// Gather metrics to verify they can be collected
	metrics, err := registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	if len(metrics) == 0 {
		t.Error("No metrics gathered")
	}

	// Count metrics
	metricCount := len(metrics)
	t.Logf("Successfully gathered %d metric families", metricCount)

	// Verify some expected metrics exist
	expectedMetrics := []string{
		"cavedogfs_browse_requests_total",
		"cavedogfs_video_requests_total",
		"cavedogfs_video_cache_hits_total",
		"cavedogfs_gif_requests_total",
		"cavedogfs_gif_cache_hits_total",
		"cavedogfs_vfs_bytes_read_total",
	}

	for _, expected := range expectedMetrics {
		found := false
		for _, mf := range metrics {
			if mf.GetName() == expected {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Expected metric %s not found", expected)
		}
	}
}

func TestMetricsNilSafety(t *testing.T) {
	// Test that methods handle nil metrics gracefully
	var m *ExplorerMetrics

	// These should not panic
	m.RecordBrowse("/test")
	m.RecordVideoRequest()
	m.RecordVideoCacheHit()
	m.RecordGIFRequest()
	m.RecordGIFCacheHit()
	m.RecordVFSRead(100)
	m.RecordVFSWrite(100)

	t.Log("All nil-safety checks passed")
}

func TestVideoCacheMetrics(t *testing.T) {
	registry := prometheus.NewRegistry()
	m := InitMetrics(registry)

	// Simulate cache behavior
	m.RecordVideoRequest() // Request 1
	m.RecordVideoCacheMiss()
	m.RecordVideoGeneration()

	m.RecordVideoRequest() // Request 2 - cache hit
	m.RecordVideoCacheHit()

	m.RecordVideoRequest() // Request 3 - cache hit
	m.RecordVideoCacheHit()

	// Gather and verify
	metrics, err := registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	var requestsTotal, cacheHits, cacheMisses, generations, avoided float64
	for _, mf := range metrics {
		switch mf.GetName() {
		case "cavedogfs_video_requests_total":
			requestsTotal = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_video_cache_hits_total":
			cacheHits = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_video_cache_misses_total":
			cacheMisses = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_video_ffmpeg_generations_total":
			generations = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_video_conversions_avoided_total":
			avoided = mf.Metric[0].Counter.GetValue()
		}
	}

	if requestsTotal != 3 {
		t.Errorf("Expected 3 video requests, got %f", requestsTotal)
	}
	if cacheHits != 2 {
		t.Errorf("Expected 2 cache hits, got %f", cacheHits)
	}
	if cacheMisses != 1 {
		t.Errorf("Expected 1 cache miss, got %f", cacheMisses)
	}
	if generations != 1 {
		t.Errorf("Expected 1 generation, got %f", generations)
	}
	if avoided != 2 {
		t.Errorf("Expected 2 conversions avoided, got %f", avoided)
	}

	t.Logf("Video cache metrics: %d requests, %d hits, %d misses, %d generations, %d avoided",
		int(requestsTotal), int(cacheHits), int(cacheMisses), int(generations), int(avoided))
}

func TestGIFCacheMetrics(t *testing.T) {
	registry := prometheus.NewRegistry()
	m := InitMetrics(registry)

	// Simulate GIF cache behavior
	m.RecordGIFRequest() // Request 1
	m.RecordGIFCacheMiss()
	m.RecordGIFGeneration()

	m.RecordGIFRequest() // Request 2 - cache hit
	m.RecordGIFCacheHit()

	m.RecordGIFRequest() // Request 3 - cache miss, different animation
	m.RecordGIFCacheMiss()
	m.RecordGIFGeneration()

	m.RecordGIFRequest() // Request 4 - cache hit
	m.RecordGIFCacheHit()

	// Gather and verify
	metrics, err := registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	var requestsTotal, cacheHits, cacheMisses, generations, avoided float64
	for _, mf := range metrics {
		switch mf.GetName() {
		case "cavedogfs_gif_requests_total":
			requestsTotal = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_gif_cache_hits_total":
			cacheHits = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_gif_cache_misses_total":
			cacheMisses = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_gif_generations_total":
			generations = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_gif_conversions_avoided_total":
			avoided = mf.Metric[0].Counter.GetValue()
		}
	}

	if requestsTotal != 4 {
		t.Errorf("Expected 4 GIF requests, got %f", requestsTotal)
	}
	if cacheHits != 2 {
		t.Errorf("Expected 2 cache hits, got %f", cacheHits)
	}
	if cacheMisses != 2 {
		t.Errorf("Expected 2 cache misses, got %f", cacheMisses)
	}
	if generations != 2 {
		t.Errorf("Expected 2 generations, got %f", generations)
	}
	if avoided != 2 {
		t.Errorf("Expected 2 conversions avoided, got %f", avoided)
	}

	t.Logf("GIF cache metrics: %d requests, %d hits, %d misses, %d generations, %d avoided",
		int(requestsTotal), int(cacheHits), int(cacheMisses), int(generations), int(avoided))
}

func TestVFSIOMetrics(t *testing.T) {
	registry := prometheus.NewRegistry()
	m := InitMetrics(registry)

	// Simulate various I/O operations
	m.RecordVFSRead(1024)  // 1 KB
	m.RecordVFSRead(2048)  // 2 KB
	m.RecordVFSRead(4096)  // 4 KB
	m.RecordVFSWrite(512)  // 512 B
	m.RecordVFSWrite(1024) // 1 KB

	// Verify atomic counters
	expectedRead := int64(1024 + 2048 + 4096)
	expectedWrite := int64(512 + 1024)

	if m.vfsBytesRead.Load() != expectedRead {
		t.Errorf("Expected vfsBytesRead to be %d, got %d", expectedRead, m.vfsBytesRead.Load())
	}
	if m.vfsBytesWritten.Load() != expectedWrite {
		t.Errorf("Expected vfsBytesWritten to be %d, got %d", expectedWrite, m.vfsBytesWritten.Load())
	}

	// Gather and verify Prometheus counters
	metrics, err := registry.Gather()
	if err != nil {
		t.Fatalf("Failed to gather metrics: %v", err)
	}

	var bytesRead, bytesWritten, readOps, writeOps float64
	for _, mf := range metrics {
		switch mf.GetName() {
		case "cavedogfs_vfs_bytes_read_total":
			bytesRead = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_vfs_bytes_written_total":
			bytesWritten = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_vfs_read_operations_total":
			readOps = mf.Metric[0].Counter.GetValue()
		case "cavedogfs_vfs_write_operations_total":
			writeOps = mf.Metric[0].Counter.GetValue()
		}
	}

	if bytesRead != float64(expectedRead) {
		t.Errorf("Expected bytes read %d, got %f", expectedRead, bytesRead)
	}
	if bytesWritten != float64(expectedWrite) {
		t.Errorf("Expected bytes written %d, got %f", expectedWrite, bytesWritten)
	}
	if readOps != 3 {
		t.Errorf("Expected 3 read operations, got %f", readOps)
	}
	if writeOps != 2 {
		t.Errorf("Expected 2 write operations, got %f", writeOps)
	}

	t.Logf("VFS I/O: %d bytes read (%d ops), %d bytes written (%d ops)",
		int64(bytesRead), int(readOps), int64(bytesWritten), int(writeOps))
}

func BenchmarkMetricsRecording(b *testing.B) {
	registry := prometheus.NewRegistry()
	m := InitMetrics(registry)

	b.Run("RecordBrowse", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			m.RecordBrowse("/test")
		}
	})

	b.Run("RecordVideoRequest", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			m.RecordVideoRequest()
		}
	})

	b.Run("RecordVFSRead", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			m.RecordVFSRead(1024)
		}
	})

	b.Run("AtomicCounter", func(b *testing.B) {
		var counter atomic.Int64
		for i := 0; i < b.N; i++ {
			counter.Add(1024)
		}
	})
}
