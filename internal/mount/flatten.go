package mount

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/spf13/cobra"
)

func newFlattenCommand() *cobra.Command {
	var targetDir string
	var verify bool

	cmd := &cobra.Command{
		Use:   "flatten [source-path]",
		Short: "Flatten VFS to directory with effective files",
		Long: `Extract the effective set of all files from the virtual filesystem to a target directory.

This creates a flattened view showing which file version "wins" after applying all
archive priorities (Physical > GP3 > CCX > HPI).

When <source-path> is omitted, the active kbot context (see 'kbot ctx')
is used as the source.

Example:
  kbot mount flatten ~/ta-content --target /tmp/ta-flat
  kbot mount flatten ~/ta-content --target /tmp/ta-flat --verify
  kbot mount flatten --target /tmp/ta-flat                # uses active context`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sourcePath, note, err := resolveContextPath(args)
			if err != nil {
				return err
			}
			if note != "" {
				fmt.Println(note)
			}
			
			// Create VFS
			cfg := &filesystem.Config{
				Extensions:         []string{".hpi", ".ccx", ".gp3", ".ufo"},
				SkipErrors:         true,
				ExcludeDirectories: []string{"Docs"},
				ExcludeExtensions:  []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
				ExcludePrefixes:    []string{"goggame"},
			}
			
			vfs, err := filesystem.NewVirtualFileSystem(sourcePath, cfg)
			if err != nil {
				return fmt.Errorf("failed to create VFS: %w", err)
			}
			defer func() { _ = vfs.Close() }()
			
			// Get all files
			files := vfs.List()
			fmt.Printf("Found %d files in VFS\n", len(files))
			
			// Create target directory
			if err := os.MkdirAll(targetDir, 0755); err != nil {
				return fmt.Errorf("failed to create target directory: %w", err)
			}
			
			// Extract files
			extracted := 0
			failed := 0
			hashes := make(map[string]string) // path -> md5
			
			for _, filePath := range files {
				// Read file from VFS
				data, err := vfs.ReadFile(filePath)
				if err != nil {
					fmt.Printf("ERROR reading %s: %v\n", filePath, err)
					failed++
					continue
				}
				
				// Calculate MD5
				hash := md5.Sum(data)
				hashes[filePath] = hex.EncodeToString(hash[:])
				
				// Write to target
				targetPath := filepath.Join(targetDir, filePath)
				targetDirPath := filepath.Dir(targetPath)
				
				if err := os.MkdirAll(targetDirPath, 0755); err != nil {
					fmt.Printf("ERROR creating directory for %s: %v\n", filePath, err)
					failed++
					continue
				}
				
				if err := os.WriteFile(targetPath, data, 0644); err != nil {
					fmt.Printf("ERROR writing %s: %v\n", filePath, err)
					failed++
					continue
				}
				
				extracted++
				if extracted%100 == 0 {
					fmt.Printf("Extracted %d/%d files...\n", extracted, len(files))
				}
			}
			
			fmt.Printf("\nExtraction complete!\n")
			fmt.Printf("  Extracted: %d files\n", extracted)
			fmt.Printf("  Failed: %d files\n", failed)
			fmt.Printf("  Target: %s\n", targetDir)
			
			// Verify if requested
			if verify {
				fmt.Printf("\nVerifying extracted files...\n")
				return verifyExtraction(targetDir, vfs, hashes)
			}
			
			return nil
		},
	}
	
	cmd.Flags().StringVarP(&targetDir, "target", "t", "", "Target directory for flattened output (required)")
	cmd.Flags().BoolVarP(&verify, "verify", "v", false, "Verify MD5 hashes after extraction")
	_ = cmd.MarkFlagRequired("target")
	
	return cmd
}

func verifyExtraction(targetDir string, vfs *filesystem.VirtualFileSystem, originalHashes map[string]string) error {
	// Create second VFS from extracted directory
	cfg := &filesystem.Config{
		Extensions:         []string{}, // No archives, just physical files
		SkipErrors:         true,
		ExcludeDirectories: []string{"Docs"},
		ExcludeExtensions:  []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
		ExcludePrefixes:    []string{"goggame"},
	}
	
	extractedVFS, err := filesystem.NewVirtualFileSystem(targetDir, cfg)
	if err != nil {
		return fmt.Errorf("failed to create VFS for verification: %w", err)
	}
	defer func() { _ = extractedVFS.Close() }()
	
	extractedFiles := extractedVFS.List()
	sort.Strings(extractedFiles)
	
	originalFiles := vfs.List()
	sort.Strings(originalFiles)
	
	// Compare counts
	if len(extractedFiles) != len(originalFiles) {
		fmt.Printf("⚠️  File count mismatch!\n")
		fmt.Printf("  Original VFS: %d files\n", len(originalFiles))
		fmt.Printf("  Extracted:    %d files\n", len(extractedFiles))
		
		// Find differences
		origSet := make(map[string]bool)
		for _, f := range originalFiles {
			origSet[f] = true
		}
		
		extractSet := make(map[string]bool)
		for _, f := range extractedFiles {
			extractSet[f] = true
		}
		
		missing := []string{}
		for _, f := range originalFiles {
			if !extractSet[f] {
				missing = append(missing, f)
			}
		}
		
		extra := []string{}
		for _, f := range extractedFiles {
			if !origSet[f] {
				extra = append(extra, f)
			}
		}
		
		if len(missing) > 0 {
			fmt.Printf("\nMissing files (%d):\n", len(missing))
			for i, f := range missing {
				if i < 10 {
					fmt.Printf("  - %s\n", f)
				}
			}
			if len(missing) > 10 {
				fmt.Printf("  ... and %d more\n", len(missing)-10)
			}
		}
		
		if len(extra) > 0 {
			fmt.Printf("\nExtra files (%d):\n", len(extra))
			for i, f := range extra {
				if i < 10 {
					fmt.Printf("  + %s\n", f)
				}
			}
			if len(extra) > 10 {
				fmt.Printf("  ... and %d more\n", len(extra)-10)
			}
		}
	}
	
	// Verify MD5 hashes
	fmt.Printf("\nVerifying MD5 hashes...\n")
	matched := 0
	mismatched := 0
	
	for _, filePath := range extractedFiles {
		// Read from extracted directory
		data, err := extractedVFS.ReadFile(filePath)
		if err != nil {
			fmt.Printf("ERROR reading extracted file %s: %v\n", filePath, err)
			mismatched++
			continue
		}
		
		// Calculate MD5
		hash := md5.Sum(data)
		extractedHash := hex.EncodeToString(hash[:])
		
		// Compare with original
		originalHash, exists := originalHashes[filePath]
		if !exists {
			fmt.Printf("⚠️  File not in original: %s\n", filePath)
			mismatched++
			continue
		}
		
		if extractedHash == originalHash {
			matched++
		} else {
			fmt.Printf("❌ Hash mismatch: %s\n", filePath)
			fmt.Printf("   Original:  %s\n", originalHash)
			fmt.Printf("   Extracted: %s\n", extractedHash)
			mismatched++
		}
	}
	
	fmt.Printf("\nVerification Results:\n")
	fmt.Printf("  ✅ Matched:    %d files\n", matched)
	fmt.Printf("  ❌ Mismatched: %d files\n", mismatched)
	
	if mismatched == 0 && len(extractedFiles) == len(originalFiles) {
		fmt.Printf("\n🎉 PERFECT! All files match!\n")
		return nil
	}
	
	return fmt.Errorf("verification failed: %d mismatches", mismatched)
}
