// Package filesystem provides a virtual filesystem that layers multiple archive formats
// (HPI, UFO, CCX, GP3) with physical files in a directory.
//
// The VFS presents a unified view of files from multiple sources:
// - Archive files (.hpi, .ufo, .ccx, .gp3)
// - Physical files on disk
//
// Files in archives are layered with higher-priority archives overriding lower-priority ones.
// Physical files always override archive files.
//
// For multi-source layering (a base game, optional parent contexts and a writable
// work folder overlaid on top) see NewLayered in layered.go.
//
// Example usage:
//
//	config := &filesystem.Config{
//	    Extensions: []string{".hpi", ".ccx", ".gp3", ".ufo"},
//	}
//	vfs, err := filesystem.NewVirtualFileSystem("/path/to/game", config)
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer func() { _ = vfs.Close() }()
//
//	// List all files
//	files := vfs.List()
//
//	// Open a file
//	reader, err := vfs.Open("units/ARMCOM.FBI")
//	if err != nil {
//	    log.Fatal(err)
//	}
//	defer func() { _ = reader.Close() }()
//
//	// Walk the filesystem
//	_ = vfs.Walk(func(path string, info FileInfo) error {
//	    fmt.Printf("%s (%d bytes)\n", path, info.Size)
//	    return nil
//	})
package filesystem

import (
	"crypto/md5"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/hpi"
)

// Config configures the virtual filesystem
type Config struct {
	// Extensions specifies which archive extensions to load
	// Example: []string{".hpi", ".ufo", ".ccx", ".gp3"}
	// If empty, defaults to all supported formats
	Extensions []string

	// ExcludeDirectories is a list of directory names to ignore (case-insensitive)
	// Example: []string{"Docs", "Backup"}
	ExcludeDirectories []string

	// ExcludeExtensions is a list of file extensions to ignore (case-insensitive)
	// Example: []string{".dll", ".exe", ".ico"}
	ExcludeExtensions []string

	// ExcludePrefixes is a list of filename prefixes to ignore (case-insensitive)
	// Example: []string{"goggame", "temp_"}
	ExcludePrefixes []string

	// CaseSensitive controls path matching (default: false for TA compatibility)
	CaseSensitive bool

	// SkipErrors continues loading even if some archives fail
	SkipErrors bool
}

// physicalSource is the layer label used for loose files found inside a context
// directory (as opposed to the writable work-folder overlay, which carries its
// own label).
const physicalSource = "Physical Filesystem"

// FileInfo provides information about a virtual file
type FileInfo struct {
	Path   string // Virtual path (e.g., "units/ARMCOM.FBI")
	Size   int64  // File size in bytes
	Source string // Source (archive name or "disk")
	IsDir  bool   // True if this is a directory
}

// Ensure VirtualFileSystem implements the filesystem interfaces
var (
	_ FileSystem         = (*VirtualFileSystem)(nil)
	_ WritableFileSystem = (*VirtualFileSystem)(nil)
)

// VirtualFileSystem provides a layered view of archive and physical files.
//
// Files are resolved through an ordered stack of sources (see NewLayered). Each
// file carries one FileLayer per source that contains it; the layer with the
// highest load sequence (the top-most source) is the active version.
type VirtualFileSystem struct {
	basePath string
	config   *Config
	archives []*archiveLayer

	// filesMu guards files, fileLayers, directories, physicalFiles and seqCounter
	// so background MD5 hashing and write operations don't race.
	filesMu       sync.RWMutex
	files         map[string]*virtualFile // Map of normalized path -> active file
	fileLayers    map[string][]FileLayer  // Map of path -> all layers containing it
	directories   map[string]bool         // Set of directory paths
	physicalFiles map[string]string       // Map of normalized path -> active physical path
	seqCounter    int                     // Monotonic layer load sequence

	// writeDir is the physical directory backing the writable overlay layer.
	// It is empty for a read-only VFS (e.g. a bare context browsing tab).
	writeDir      string
	writableLabel string // FileLayer.Source label for the writable overlay

	md5Hashes map[string]string // Map of normalized path -> MD5 hex hash
	md5Mutex  sync.RWMutex      // Protects md5Hashes

	// Metrics callback for tracking I/O
	metricsCallback func(bytes int64)
	metricsMutex    sync.RWMutex
}

// archiveLayer represents a loaded archive
type archiveLayer struct {
	name        string
	reader      hpi.Archive
	archivePath string
	mu          sync.Mutex // Protects reader access
}

// virtualFile represents the active version of a file in the VFS
type virtualFile struct {
	path    string // Normalized path
	size    int64
	source  string // Archive name or "disk"
	archive *archiveLayer
}

// NewVirtualFileSystem creates a read-only virtual filesystem over a single
// directory (its archives plus loose physical files). It is a thin wrapper over
// NewLayered for backward compatibility.
func NewVirtualFileSystem(basePath string, config *Config) (*VirtualFileSystem, error) {
	return NewLayered([]Source{{Kind: SourceContextDir, Path: basePath}}, config)
}

// newVFS allocates an empty VFS with the given config and initialised maps.
func newVFS(config *Config) *VirtualFileSystem {
	return &VirtualFileSystem{
		config:        config,
		fileLayers:    make(map[string][]FileLayer),
		archives:      make([]*archiveLayer, 0),
		files:         make(map[string]*virtualFile),
		directories:   make(map[string]bool),
		physicalFiles: make(map[string]string),
		md5Hashes:     make(map[string]string),
	}
}

// Close closes all open archives
func (vfs *VirtualFileSystem) Close() error {
	var lastErr error
	for _, archive := range vfs.archives {
		if err := archive.reader.Close(); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

// nextSeq returns the next monotonic load sequence. Callers must hold filesMu
// when invoking this concurrently with writes; it is unlocked during initial
// load, which is single-threaded.
func (vfs *VirtualFileSystem) nextSeq() int {
	vfs.seqCounter++
	return vfs.seqCounter
}

// addDirs registers all parent directories of a normalized path.
func (vfs *VirtualFileSystem) addDirs(normalized string) {
	dir := filepath.Dir(normalized)
	for dir != "." && dir != "/" && dir != "" {
		vfs.directories[dir] = true
		dir = filepath.Dir(dir)
	}
}

// applyLayer records a layer for a path and makes it the active version. It is
// used during the initial (single-threaded) load, where layers are applied in
// ascending sequence so the last one applied is always the highest priority.
func (vfs *VirtualFileSystem) applyLayer(normalized string, layer FileLayer) {
	vfs.fileLayers[normalized] = append(vfs.fileLayers[normalized], layer)
	vfs.setActiveFromLayer(normalized, layer)
}

// setActiveFromLayer points the active-file maps at the given layer.
func (vfs *VirtualFileSystem) setActiveFromLayer(normalized string, layer FileLayer) {
	if layer.archive != nil {
		vfs.files[normalized] = &virtualFile{
			path:    normalized,
			size:    layer.Size,
			source:  layer.Source,
			archive: layer.archive,
		}
		delete(vfs.physicalFiles, normalized)
		return
	}
	vfs.files[normalized] = &virtualFile{
		path:   normalized,
		size:   layer.Size,
		source: "disk",
	}
	vfs.physicalFiles[normalized] = layer.physPath
}

// loadArchivesFrom loads all archive files found under basePath in priority order.
func (vfs *VirtualFileSystem) loadArchivesFrom(basePath string) error {
	archivesByExt := make(map[string][]string) // extension -> []paths

	err := filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}

		ext := strings.ToLower(filepath.Ext(path))
		for _, validExt := range vfs.config.Extensions {
			if ext == strings.ToLower(validExt) {
				archivesByExt[ext] = append(archivesByExt[ext], path)
				break
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("failed to scan for archives: %w", err)
	}

	// Define extension priority order (lowest to highest).
	extensionOrder := []string{".hpi", ".ccx", ".gp3", ".ufo"}

	for _, ext := range extensionOrder {
		paths, exists := archivesByExt[ext]
		if !exists {
			continue
		}

		// Sort files within same extension alphabetically.
		sort.Strings(paths)

		for _, path := range paths {
			name := filepath.Base(path)
			if err := vfs.loadArchive(name, path); err != nil {
				if vfs.config.SkipErrors {
					continue
				}
				return fmt.Errorf("failed to load archive %s: %w", name, err)
			}
		}
	}

	return nil
}

// loadArchive loads a single archive and adds its files to the VFS as one layer.
func (vfs *VirtualFileSystem) loadArchive(name, path string) error {
	reader, err := hpi.OpenReader(path)
	if err != nil {
		return err
	}

	layer := &archiveLayer{
		name:        name,
		reader:      reader,
		archivePath: path,
	}
	vfs.archives = append(vfs.archives, layer)

	seq := vfs.nextSeq()

	return reader.Walk(func(entry *hpi.Entry) error {
		if entry.IsDir {
			return nil
		}

		filePath := entry.FullPath()
		if vfs.ShouldExclude(filePath, false) {
			return nil
		}

		normalized := vfs.normalizePath(filePath)
		vfs.addDirs(normalized)
		vfs.applyLayer(normalized, FileLayer{
			Source:  name,
			Size:    int64(entry.Size),
			seq:     seq,
			archive: layer,
		})
		return nil
	})
}

// scanLooseFrom scans for loose (non-archive) physical files under basePath and
// records them as a single layer with the given source label.
func (vfs *VirtualFileSystem) scanLooseFrom(basePath, label string) error {
	seq := vfs.nextSeq()

	return filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(basePath, path)
		if err != nil {
			return err
		}
		if relPath == "." {
			return nil
		}

		// Skip archive files; they are handled by loadArchivesFrom.
		if !info.IsDir() {
			ext := strings.ToLower(filepath.Ext(path))
			for _, archiveExt := range vfs.config.Extensions {
				if ext == strings.ToLower(archiveExt) {
					return nil
				}
			}
		}

		if vfs.ShouldExclude(relPath, info.IsDir()) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		normalized := vfs.normalizePath(relPath)
		if info.IsDir() {
			vfs.directories[normalized] = true
			return nil
		}

		vfs.addDirs(normalized)
		vfs.applyLayer(normalized, FileLayer{
			Source:   label,
			Size:     info.Size(),
			seq:      seq,
			physPath: path,
		})
		return nil
	})
}

// normalizePath normalizes a path for storage in the VFS
func (vfs *VirtualFileSystem) normalizePath(path string) string {
	// Convert to forward slashes
	path = filepath.ToSlash(path)

	// Remove leading slash
	path = strings.TrimPrefix(path, "/")

	// Case sensitivity
	if !vfs.config.CaseSensitive {
		path = strings.ToLower(path)
	}

	return path
}

// ShouldExclude checks if a file/directory should be excluded based on config
func (vfs *VirtualFileSystem) ShouldExclude(filePath string, isDir bool) bool {
	// Normalize path for consistent checking
	normalizedPath := vfs.normalizePath(filePath)
	parts := strings.Split(normalizedPath, "/")

	// Check if any directory in the path is excluded (case-insensitive)
	for _, part := range parts {
		for _, excludeDir := range vfs.config.ExcludeDirectories {
			if strings.EqualFold(part, excludeDir) {
				return true
			}
		}
	}

	// Check file-specific exclusions (only for files, not directories)
	if !isDir {
		// Get just the filename (without directory path)
		filename := filepath.Base(filePath)
		filenameLower := strings.ToLower(filename)

		// Check file extension (case-insensitive)
		ext := strings.ToLower(filepath.Ext(filePath))
		for _, excludeExt := range vfs.config.ExcludeExtensions {
			// Ensure extension starts with a dot
			excludeExtLower := strings.ToLower(excludeExt)
			if !strings.HasPrefix(excludeExtLower, ".") {
				excludeExtLower = "." + excludeExtLower
			}
			if ext == excludeExtLower {
				return true
			}
		}

		// Check filename prefix (case-insensitive)
		for _, prefix := range vfs.config.ExcludePrefixes {
			if strings.HasPrefix(filenameLower, strings.ToLower(prefix)) {
				return true
			}
		}
	}

	return false
}

// Open opens a file for reading
func (vfs *VirtualFileSystem) Open(path string) (io.ReadCloser, error) {
	normalized := vfs.normalizePath(path)

	vfs.filesMu.RLock()
	file, exists := vfs.files[normalized]
	physicalPath := vfs.physicalFiles[normalized]
	vfs.filesMu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("file not found: %s", path)
	}

	// Physical file?
	if file.source == "disk" {
		return os.Open(physicalPath)
	}

	// Archive file
	if file.archive == nil {
		return nil, fmt.Errorf("no archive for file: %s", path)
	}

	// Lock the archive reader for thread-safe access
	file.archive.mu.Lock()
	defer file.archive.mu.Unlock()

	return file.archive.reader.Open(file.path)
}

// Exists checks if a file or directory exists
func (vfs *VirtualFileSystem) Exists(path string) bool {
	normalized := vfs.normalizePath(path)

	vfs.filesMu.RLock()
	defer vfs.filesMu.RUnlock()

	if _, exists := vfs.files[normalized]; exists {
		return true
	}
	return vfs.directories[normalized]
}

// IsDir checks if a path is a directory
func (vfs *VirtualFileSystem) IsDir(path string) bool {
	normalized := vfs.normalizePath(path)
	// Root is always a directory
	if normalized == "" {
		return true
	}
	vfs.filesMu.RLock()
	defer vfs.filesMu.RUnlock()
	return vfs.directories[normalized]
}

// Stat returns information about a file
func (vfs *VirtualFileSystem) Stat(path string) (*FileInfo, error) {
	normalized := vfs.normalizePath(path)

	vfs.filesMu.RLock()
	defer vfs.filesMu.RUnlock()

	// Check if it's a file
	if file, exists := vfs.files[normalized]; exists {
		return &FileInfo{
			Path:   file.path,
			Size:   file.size,
			Source: file.source,
			IsDir:  false,
		}, nil
	}

	// Check if it's a directory
	if vfs.directories[normalized] {
		return &FileInfo{
			Path:   normalized,
			Size:   0,
			Source: "vfs",
			IsDir:  true,
		}, nil
	}

	return nil, fmt.Errorf("path not found: %s", path)
}

// List returns all files in the VFS
func (vfs *VirtualFileSystem) List() []string {
	vfs.filesMu.RLock()
	files := make([]string, 0, len(vfs.files))
	for path := range vfs.files {
		files = append(files, path)
	}
	vfs.filesMu.RUnlock()

	sort.Strings(files)
	return files
}

// ListDir returns files in a specific directory
func (vfs *VirtualFileSystem) ListDir(dir string) ([]string, error) {
	normalized := vfs.normalizePath(dir)

	vfs.filesMu.RLock()
	defer vfs.filesMu.RUnlock()

	if !vfs.directories[normalized] && normalized != "" && normalized != "." {
		return nil, fmt.Errorf("not a directory: %s", dir)
	}

	prefix := normalized
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	files := make([]string, 0)
	seen := make(map[string]bool)

	// Find direct children among files
	for path := range vfs.files {
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		remainder := strings.TrimPrefix(path, prefix)
		parts := strings.Split(remainder, "/")
		if len(parts) > 0 && parts[0] != "" {
			child := parts[0]
			if !seen[child] {
				files = append(files, child)
				seen[child] = true
			}
		}
	}

	// Add directories
	for dirPath := range vfs.directories {
		if !strings.HasPrefix(dirPath, prefix) {
			continue
		}
		remainder := strings.TrimPrefix(dirPath, prefix)
		parts := strings.Split(remainder, "/")
		if len(parts) > 0 && parts[0] != "" {
			child := parts[0]
			if !seen[child] {
				files = append(files, child)
				seen[child] = true
			}
		}
	}

	sort.Strings(files)
	return files, nil
}

// Walk walks the entire filesystem tree
func (vfs *VirtualFileSystem) Walk(fn func(path string, info *FileInfo) error) error {
	// Snapshot all paths under the read lock, then Stat each without holding it.
	vfs.filesMu.RLock()
	allPaths := make(map[string]bool, len(vfs.files)+len(vfs.directories))
	for path := range vfs.files {
		allPaths[path] = true
	}
	for dir := range vfs.directories {
		allPaths[dir] = true
	}
	vfs.filesMu.RUnlock()

	paths := make([]string, 0, len(allPaths))
	for path := range allPaths {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	for _, path := range paths {
		info, err := vfs.Stat(path)
		if err != nil {
			// The path may have been removed between snapshot and Stat; skip it.
			continue
		}
		if err := fn(path, info); err != nil {
			return err
		}
	}

	return nil
}

// ReadFile reads an entire file into memory
func (vfs *VirtualFileSystem) ReadFile(path string) ([]byte, error) {
	reader, err := vfs.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()

	data, err := io.ReadAll(reader)
	if err == nil {
		vfs.recordBytesRead(int64(len(data)))
	}
	return data, err
}

// ReadFileFromSource reads a file from a specific source layer.
// sourceName can be the physical/overlay label or an archive name like "totala1.hpi".
func (vfs *VirtualFileSystem) ReadFileFromSource(path, sourceName string) ([]byte, error) {
	normalized := vfs.normalizePath(path)

	// Resolve the physical path for a loose/overlay layer under the read lock.
	vfs.filesMu.RLock()
	var physPath string
	var physOK bool
	for _, l := range vfs.fileLayers[normalized] {
		if l.Source == sourceName && l.archive == nil {
			physPath = l.physPath
			physOK = true
			break
		}
	}
	vfs.filesMu.RUnlock()

	if physOK {
		data, err := os.ReadFile(physPath)
		if err == nil {
			vfs.recordBytesRead(int64(len(data)))
		}
		return data, err
	}

	// Find matching archive layer (archives are immutable after load).
	for _, layer := range vfs.archives {
		if layer.name == sourceName {
			layer.mu.Lock()
			defer layer.mu.Unlock()

			rc, err := layer.reader.Open(normalized)
			if err != nil {
				return nil, fmt.Errorf("file not found in %s", sourceName)
			}
			defer func() { _ = rc.Close() }()

			data, err := io.ReadAll(rc)
			if err == nil {
				vfs.recordBytesRead(int64(len(data)))
			}
			return data, err
		}
	}

	return nil, fmt.Errorf("source not found: %s", sourceName)
}

// Archives returns information about loaded archives
func (vfs *VirtualFileSystem) Archives() []string {
	archives := make([]string, len(vfs.archives))
	for i, archive := range vfs.archives {
		archives[i] = archive.name
	}
	return archives
}

// Stats returns statistics about the VFS
func (vfs *VirtualFileSystem) Stats() map[string]interface{} {
	archiveFileCount := 0
	physicalFileCount := 0
	totalUnpackedSize := int64(0)
	totalPackedSize := int64(0)

	vfs.filesMu.RLock()
	for _, file := range vfs.files {
		if file.source == "disk" {
			physicalFileCount++
		} else {
			archiveFileCount++
		}
		totalUnpackedSize += file.size
	}
	totalFiles := len(vfs.files)
	dirCount := len(vfs.directories)
	vfs.filesMu.RUnlock()

	// Calculate packed size from archive files (archives are immutable post-load).
	for _, layer := range vfs.archives {
		if fileInfo, err := os.Stat(layer.archivePath); err == nil {
			totalPackedSize += fileInfo.Size()
		}
	}

	// Calculate compression ratio
	compressionRatio := 0.0
	if totalUnpackedSize > 0 {
		compressionRatio = (1.0 - float64(totalPackedSize)/float64(totalUnpackedSize)) * 100
	}

	return map[string]interface{}{
		"archives":            len(vfs.archives),
		"total_files":         totalFiles,
		"archive_files":       archiveFileCount,
		"physical_files":      physicalFileCount,
		"directories":         dirCount,
		"total_unpacked_size": totalUnpackedSize,
		"total_packed_size":   totalPackedSize,
		"compression_ratio":   compressionRatio,
		"base_path":           vfs.basePath,
		"archive_names":       vfs.Archives(),
	}
}

// DirectoryStats returns statistics for a specific directory
func (vfs *VirtualFileSystem) DirectoryStats(dirPath string) map[string]interface{} {
	dirPath = vfs.normalizePath(dirPath)

	fileCount := 0
	subdirCount := 0
	totalSize := int64(0)

	vfs.filesMu.RLock()
	for path, file := range vfs.files {
		if filepath.Dir(path) == dirPath {
			fileCount++
			totalSize += file.size
		}
	}
	for dir := range vfs.directories {
		if filepath.Dir(dir) == dirPath {
			subdirCount++
		}
	}
	vfs.filesMu.RUnlock()

	return map[string]interface{}{
		"path":           dirPath,
		"files":          fileCount,
		"subdirectories": subdirCount,
		"total_size":     totalSize,
	}
}

// RecursiveDirectoryStats returns statistics for a directory and all subdirectories
func (vfs *VirtualFileSystem) RecursiveDirectoryStats(dirPath string) map[string]interface{} {
	dirPath = vfs.normalizePath(dirPath)

	fileCount := 0
	subdirCount := 0
	totalSize := int64(0)

	prefix := dirPath
	if prefix != "" && prefix != "." {
		prefix = prefix + "/"
	} else {
		prefix = ""
	}

	vfs.filesMu.RLock()
	for path, file := range vfs.files {
		if prefix == "" || strings.HasPrefix(path, prefix) {
			fileCount++
			totalSize += file.size
		}
	}
	for dir := range vfs.directories {
		if prefix == "" || strings.HasPrefix(dir, prefix) {
			if dir != dirPath { // Don't count the directory itself
				subdirCount++
			}
		}
	}
	vfs.filesMu.RUnlock()

	return map[string]interface{}{
		"path":           dirPath,
		"files":          fileCount,
		"subdirectories": subdirCount,
		"total_size":     totalSize,
	}
}

// FileLayer represents a single layer containing a file
type FileLayer struct {
	Source   string // Archive name or physical/overlay label
	Priority int    // Layer priority (lower = higher priority); assigned by GetFileLayers
	Size     int64  // File size in this layer

	seq      int           // Monotonic load sequence (higher = higher priority)
	archive  *archiveLayer // Set for archive layers
	physPath string        // Set for physical/overlay layers
}

// GetFileLayers returns all layers containing this file, ordered by priority
// (index 0 = highest priority = the active version).
func (vfs *VirtualFileSystem) GetFileLayers(path string) []FileLayer {
	normalized := vfs.normalizePath(path)

	vfs.filesMu.RLock()
	layers := vfs.fileLayers[normalized]
	result := make([]FileLayer, len(layers))
	copy(result, layers)
	vfs.filesMu.RUnlock()

	// Higher load sequence = higher priority (lower Priority number).
	sort.Slice(result, func(i, j int) bool {
		return result[i].seq > result[j].seq
	})
	for i := range result {
		result[i].Priority = i
	}

	return result
}

// startMD5Calculation starts background MD5 calculation for all files
// Uses a worker pool of 10 goroutines to parallelize the work
func (vfs *VirtualFileSystem) startMD5Calculation() {
	const numWorkers = 10

	filePaths := make(chan string, 100)

	var wg sync.WaitGroup
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range filePaths {
				vfs.calculateFileMD5(path)
			}
		}()
	}

	// Snapshot the path set under the read lock, then feed the workers.
	go func() {
		vfs.filesMu.RLock()
		paths := make([]string, 0, len(vfs.files))
		for path := range vfs.files {
			paths = append(paths, path)
		}
		vfs.filesMu.RUnlock()

		for _, path := range paths {
			filePaths <- path
		}
		close(filePaths)
		wg.Wait()
	}()
}

// calculateFileMD5 calculates and stores the MD5 hash for a single file
func (vfs *VirtualFileSystem) calculateFileMD5(path string) {
	reader, err := vfs.Open(path)
	if err != nil {
		return // Skip files that can't be opened
	}
	defer func() { _ = reader.Close() }()

	hash := md5.New()
	if _, err := io.Copy(hash, reader); err != nil {
		return // Skip files with read errors
	}

	md5Sum := fmt.Sprintf("%x", hash.Sum(nil))
	vfs.md5Mutex.Lock()
	vfs.md5Hashes[path] = md5Sum
	vfs.md5Mutex.Unlock()
}

// GetMD5 returns the MD5 hash for a file if it has been calculated
// Returns (hash, true) if available, ("", false) if not yet calculated
func (vfs *VirtualFileSystem) GetMD5(path string) (string, bool) {
	normalized := vfs.normalizePath(path)

	vfs.md5Mutex.RLock()
	hash, exists := vfs.md5Hashes[normalized]
	vfs.md5Mutex.RUnlock()

	return hash, exists
}

// SetMetricsCallback sets a callback function for tracking bytes read
func (vfs *VirtualFileSystem) SetMetricsCallback(callback func(bytes int64)) {
	vfs.metricsMutex.Lock()
	defer vfs.metricsMutex.Unlock()
	vfs.metricsCallback = callback
}

// recordBytesRead calls the metrics callback if set
func (vfs *VirtualFileSystem) recordBytesRead(bytes int64) {
	vfs.metricsMutex.RLock()
	callback := vfs.metricsCallback
	vfs.metricsMutex.RUnlock()

	if callback != nil {
		callback(bytes)
	}
}
