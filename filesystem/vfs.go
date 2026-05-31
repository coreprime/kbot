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

// extensionPriority defines the loading order for archive types
// Lower number = lower priority (loaded first, overridden by later)


// FileInfo provides information about a virtual file
type FileInfo struct {
	Path   string // Virtual path (e.g., "units/ARMCOM.FBI")
	Size   int64  // File size in bytes
	Source string // Source (archive name or "disk")
	IsDir  bool   // True if this is a directory
}

// Ensure VirtualFileSystem implements FileSystem
var _ FileSystem = (*VirtualFileSystem)(nil)

// VirtualFileSystem provides a layered view of archive and physical files
type VirtualFileSystem struct {
	basePath      string
	config        *Config
	archives      []*archiveLayer
	files         map[string]*virtualFile // Map of normalized path -> file
	fileLayers    map[string][]FileLayer  // Map of path -> all layers containing it
	directories   map[string]bool         // Set of directory paths
	physicalFiles map[string]string       // Map of normalized path -> physical path
	md5Hashes     map[string]string       // Map of normalized path -> MD5 hex hash
	md5Mutex      sync.RWMutex            // Protects md5Hashes
	
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

// virtualFile represents a file in the VFS
type virtualFile struct {
	path    string // Normalized path
	size    int64
	source  string // Archive name or "disk"
	archive *archiveLayer
}

// NewVirtualFileSystem creates a new virtual filesystem
func NewVirtualFileSystem(basePath string, config *Config) (*VirtualFileSystem, error) {
	if config == nil {
		config = &Config{
			Extensions: []string{".hpi", ".ccx", ".gp3", ".ufo"},
		}
	}
	
	// Set default extensions if not specified
	if len(config.Extensions) == 0 {
		config.Extensions = []string{".hpi", ".ccx", ".gp3", ".ufo"}
	}

	vfs := &VirtualFileSystem{
		basePath:      basePath,
		config:        config,
		fileLayers:    make(map[string][]FileLayer),
		archives:      make([]*archiveLayer, 0),
		files:         make(map[string]*virtualFile),
		directories:   make(map[string]bool),
		physicalFiles: make(map[string]string),
		md5Hashes:     make(map[string]string),
	}

	// Load archives in priority order
	if err := vfs.loadArchives(); err != nil {
		if !config.SkipErrors {
			return nil, err
		}
	}

	// Scan physical files
	if err := vfs.scanPhysicalFiles(); err != nil {
		if !config.SkipErrors {
			return nil, err
		}
	}

	// Start background MD5 calculation
	vfs.startMD5Calculation()

	return vfs, nil
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

// loadArchives loads all archive files from the base path
func (vfs *VirtualFileSystem) loadArchives() error {
	// Find all archive files grouped by extension
	archivesByExt := make(map[string][]string) // extension -> []paths

	err := filepath.Walk(vfs.basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}

		// Check if extension matches
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

	// Define extension priority order
	extensionOrder := []string{".hpi", ".ccx", ".gp3", ".ufo"}
	
	// Load archives by extension priority (lowest to highest)
	for _, ext := range extensionOrder {
		paths, exists := archivesByExt[ext]
		if !exists {
			continue
		}

		// Sort files within same extension alphabetically
		sort.Strings(paths)

		// Load each archive of this type
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

// loadArchive loads a single archive and adds its files to the VFS
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

	// Add all files from this archive by walking the entry tree
	err = reader.Walk(func(entry *hpi.Entry) error {
		if entry.IsDir {
			return nil
		}

		filePath := entry.FullPath()
		
		// Check if file should be excluded
		if vfs.ShouldExclude(filePath, false) {
			return nil // Skip this file
		}
		
		normalized := vfs.normalizePath(filePath)

		// Add directory entries for all parent directories
		dir := filepath.Dir(normalized)
		for dir != "." && dir != "/" && dir != "" {
			vfs.directories[dir] = true
			dir = filepath.Dir(dir)
		}

		// Track this layer for the file
		// Archive priority increases with index (later = higher priority)
		archivePriority := len(vfs.archives) // Current archive gets priority based on load order
		vfs.fileLayers[normalized] = append(vfs.fileLayers[normalized], FileLayer{
			Source:   name,
			Priority: archivePriority,
			Size:     int64(entry.Size),
		})

		// Add or override file entry with actual size from Entry
		// Later archives override earlier ones
		vfs.files[normalized] = &virtualFile{
			path:    normalized,
			size:    int64(entry.Size), // Get actual size from archive entry
			source:  name,
			archive: layer,
		}
		
		return nil
	})

	return err
}

// scanPhysicalFiles scans for physical files in the base directory
func (vfs *VirtualFileSystem) scanPhysicalFiles() error {
	return filepath.Walk(vfs.basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Get relative path
		relPath, err := filepath.Rel(vfs.basePath, path)
		if err != nil {
			return err
		}

		// Skip base directory
		if relPath == "." {
			return nil
		}

		// Skip archive files
		ext := strings.ToLower(filepath.Ext(path))
		for _, archiveExt := range vfs.config.Extensions {
			if ext == strings.ToLower(archiveExt) {
				return nil
			}
		}

		// Check if file/directory should be excluded
		if vfs.ShouldExclude(relPath, info.IsDir()) {
			if info.IsDir() {
				return filepath.SkipDir // Skip entire directory
			}
			return nil // Skip this file
		}

		normalized := vfs.normalizePath(relPath)

		if info.IsDir() {
			vfs.directories[normalized] = true
		} else {
			// Track physical file layer (priority 0 = highest)
			vfs.fileLayers[normalized] = append([]FileLayer{{
				Source:   "Physical Filesystem",
				Priority: 0,
				Size:     info.Size(),
			}}, vfs.fileLayers[normalized]...) // Prepend to existing layers

			// Physical files always override archive files
			vfs.files[normalized] = &virtualFile{
				path:   normalized,
				size:   info.Size(),
				source: "disk",
			}
			vfs.physicalFiles[normalized] = path
		}

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

	file, exists := vfs.files[normalized]
	if !exists {
		return nil, fmt.Errorf("file not found: %s", path)
	}

	// Physical file?
	if file.source == "disk" {
		physicalPath := vfs.physicalFiles[normalized]
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
	
	if _, exists := vfs.files[normalized]; exists {
		return true
	}
	
	if vfs.directories[normalized] {
		return true
	}
	
	return false
}

// IsDir checks if a path is a directory
func (vfs *VirtualFileSystem) IsDir(path string) bool {
	normalized := vfs.normalizePath(path)
	// Root is always a directory
	if normalized == "" {
		return true
	}
	return vfs.directories[normalized]
}

// Stat returns information about a file
func (vfs *VirtualFileSystem) Stat(path string) (*FileInfo, error) {
	normalized := vfs.normalizePath(path)

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
	files := make([]string, 0, len(vfs.files))
	for path := range vfs.files {
		files = append(files, path)
	}
	sort.Strings(files)
	return files
}

// ListDir returns files in a specific directory
func (vfs *VirtualFileSystem) ListDir(dir string) ([]string, error) {
	normalized := vfs.normalizePath(dir)
	
	if !vfs.directories[normalized] && normalized != "" && normalized != "." {
		return nil, fmt.Errorf("not a directory: %s", dir)
	}

	files := make([]string, 0)
	prefix := normalized
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	seen := make(map[string]bool)

	// Find direct children
	for path := range vfs.files {
		if !strings.HasPrefix(path, prefix) {
			continue
		}

		// Get the part after prefix
		remainder := strings.TrimPrefix(path, prefix)
		
		// Get first component
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
	// Get all paths (files and directories)
	allPaths := make(map[string]bool)
	
	for path := range vfs.files {
		allPaths[path] = true
	}
	
	for dir := range vfs.directories {
		allPaths[dir] = true
	}

	// Sort paths
	paths := make([]string, 0, len(allPaths))
	for path := range allPaths {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	// Walk each path
	for _, path := range paths {
		info, err := vfs.Stat(path)
		if err != nil {
			return err
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

// ReadFileFromSource reads a file from a specific source layer
// sourceName can be "Physical Filesystem" or an archive name like "totala1.hpi"
func (vfs *VirtualFileSystem) ReadFileFromSource(path, sourceName string) ([]byte, error) {
	path = vfs.normalizePath(path)
	
	// Check physical filesystem first
	if sourceName == "Physical Filesystem" {
		if physPath, exists := vfs.physicalFiles[path]; exists {
			data, err := os.ReadFile(physPath)
			if err == nil {
				vfs.recordBytesRead(int64(len(data)))
			}
			return data, err
		}
		return nil, fmt.Errorf("file not found in physical filesystem")
	}
	
	// Find matching archive layer
	for _, layer := range vfs.archives {
		if layer.name == sourceName {
			layer.mu.Lock()
			defer layer.mu.Unlock()
			
			// Open file from this archive
			rc, err := layer.reader.Open(path)
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

	// Count files and sizes
	for _, file := range vfs.files {
		if file.source == "disk" {
			physicalFileCount++
		} else {
			archiveFileCount++
		}
		totalUnpackedSize += file.size
	}

	// Calculate packed size from archive files
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
		"archives":           len(vfs.archives),
		"total_files":        len(vfs.files),
		"archive_files":      archiveFileCount,
		"physical_files":     physicalFileCount,
		"directories":        len(vfs.directories),
		"total_unpacked_size": totalUnpackedSize,
		"total_packed_size":   totalPackedSize,
		"compression_ratio":   compressionRatio,
		"base_path":          vfs.basePath,
		"archive_names":      vfs.Archives(),
	}
}

// DirectoryStats returns statistics for a specific directory
func (vfs *VirtualFileSystem) DirectoryStats(dirPath string) map[string]interface{} {
	dirPath = vfs.normalizePath(dirPath)
	
	fileCount := 0
	subdirCount := 0
	totalSize := int64(0)
	
	// Count files in this directory
	for path, file := range vfs.files {
		if filepath.Dir(path) == dirPath {
			fileCount++
			totalSize += file.size
		}
	}
	
	// Count subdirectories
	for dir := range vfs.directories {
		if filepath.Dir(dir) == dirPath {
			subdirCount++
		}
	}
	
	return map[string]interface{}{
		"path":             dirPath,
		"files":            fileCount,
		"subdirectories":   subdirCount,
		"total_size":       totalSize,
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
	
	// Count all files under this directory
	for path, file := range vfs.files {
		if prefix == "" || strings.HasPrefix(path, prefix) {
			fileCount++
			totalSize += file.size
		}
	}
	
	// Count all subdirectories under this directory
	for dir := range vfs.directories {
		if prefix == "" || strings.HasPrefix(dir, prefix) {
			if dir != dirPath { // Don't count the directory itself
				subdirCount++
			}
		}
	}
	
	return map[string]interface{}{
		"path":             dirPath,
		"files":            fileCount,
		"subdirectories":   subdirCount,
		"total_size":       totalSize,
	}
}

// FileLayer represents a single layer containing a file
type FileLayer struct {
	Source   string // Archive name or "physical"
	Priority int    // Layer priority (lower = higher priority)
	Size     int64  // File size in this layer
}

// GetFileLayers returns all layers containing this file (ordered by priority)
func (vfs *VirtualFileSystem) GetFileLayers(path string) []FileLayer {
	path = vfs.normalizePath(path)
	
	// Return pre-built layers from index
	layers := vfs.fileLayers[path]
	if layers == nil {
		return []FileLayer{}
	}
	
	// Make a copy to avoid modifying the cached data
	result := make([]FileLayer, len(layers))
	copy(result, layers)
	
	// Reassign priorities based on archive order
	// Physical files (if any) already have priority 0
	// Archives loaded later have higher priority
	numArchives := len(vfs.archives)
	for i := range result {
		if result[i].Source != "Physical Filesystem" {
			// Find the archive index for this source
			for archiveIdx, archive := range vfs.archives {
				if archive.name == result[i].Source {
					// Reverse priority: later archives (higher index) = higher priority (lower number)
					result[i].Priority = numArchives - archiveIdx
					break
				}
			}
		}
	}
	
	// Sort by priority (0 = highest priority = active file)
	sort.Slice(result, func(i, j int) bool {
		return result[i].Priority < result[j].Priority
	})
	
	return result
}

// startMD5Calculation starts background MD5 calculation for all files
// Uses a worker pool of 10 goroutines to parallelize the work
func (vfs *VirtualFileSystem) startMD5Calculation() {
	const numWorkers = 10
	
	// Create channel for file paths to process
	filePaths := make(chan string, 100)
	
	// Start worker goroutines
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
	
	// Send all file paths to workers in a separate goroutine
	go func() {
		for path := range vfs.files {
			filePaths <- path
		}
		close(filePaths)
		wg.Wait() // Wait for all workers to finish
	}()
}

// calculateFileMD5 calculates and stores the MD5 hash for a single file
func (vfs *VirtualFileSystem) calculateFileMD5(path string) {
	// Read file content
	reader, err := vfs.Open(path)
	if err != nil {
		return // Skip files that can't be opened
	}
	defer func() { _ = reader.Close() }()
	
	// Calculate MD5
	hash := md5.New()
	if _, err := io.Copy(hash, reader); err != nil {
		return // Skip files with read errors
	}
	
	// Store hash
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
