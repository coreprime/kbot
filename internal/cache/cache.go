package cache

import (
	"crypto/md5"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Cache manages cached transcoded files
type Cache struct {
	dir string
}

// New creates a new cache in the specified directory
func New(dir string) (*Cache, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	return &Cache{dir: dir}, nil
}

// GetPath returns the cache file path for the given content hash and extension
func (c *Cache) GetPath(contentHash, ext string) string {
	return filepath.Join(c.dir, contentHash+ext)
}

// Has checks if a cached file exists for the given content
func (c *Cache) Has(data []byte, ext string) (string, bool) {
	hash := hashData(data)
	path := c.GetPath(hash, ext)
	if _, err := os.Stat(path); err == nil {
		return path, true
	}
	return "", false
}

// Put stores data in the cache
func (c *Cache) Put(sourceData []byte, ext string, resultPath string) (string, error) {
	hash := hashData(sourceData)
	cachePath := c.GetPath(hash, ext)
	
	// Copy result to cache
	src, err := os.Open(resultPath)
	if err != nil {
		return "", err
	}
	defer func() { _ = src.Close() }()
	
	dst, err := os.Create(cachePath)
	if err != nil {
		return "", err
	}
	defer func() { _ = dst.Close() }()
	
	if _, err := io.Copy(dst, src); err != nil {
		return "", err
	}
	
	return cachePath, nil
}

// HashData returns MD5 hash of data as hex string
func HashData(data []byte) string {
	hash := md5.Sum(data)
	return fmt.Sprintf("%x", hash)
}

// hashData is deprecated, use HashData
func hashData(data []byte) string {
	return HashData(data)
}
