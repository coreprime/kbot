// Package explorer provides KBot Explorer - an interactive filesystem browser for Total Annihilation archives
package explorer

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/ai"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/spf13/cobra"
)

var (
	vfs        *filesystem.VirtualFileSystem
	currentDir string
	serverMode bool
	serverPort int
	noCache    bool
	clearCache bool
)

// NewCommand returns the explorer cobra command tree, suitable for
// embedding as a subcommand in a larger CLI (e.g. kbot mount).
func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "mount <path>",
		Short: "Browse Total Annihilation archives interactively",
		Long: `Mount and browse Total Annihilation game files from HPI, UFO, CCX,
and GP3 archives in an interactive terminal or web UI.

Terminal Mode Commands:
  ls [path]           - List directory contents
  cd <path>           - Change directory
  pwd                 - Print working directory
  cat <file>          - Display file contents
  describe <file>     - Show metadata for TDF/FBI/GAF files
  archives            - List loaded archives
  stats               - Show filesystem statistics
  help                - Show available commands
  exit/quit           - Exit the browser

Web Server Mode:
  Use --server flag to run as a web server instead of terminal mode`,
		Args: cobra.ExactArgs(1),
		RunE: runBrowser,
	}

	cmd.Flags().BoolVarP(&serverMode, "server", "s", false, "Run as web server")
	cmd.Flags().IntVarP(&serverPort, "port", "p", 8000, "Web server port (default 8000)")
	cmd.Flags().BoolVar(&noCache, "no-cache", false, "Disable caching (server mode only)")
	cmd.Flags().BoolVar(&clearCache, "clear-cache", false, "Clear all caches on startup (server mode only)")

	cmd.AddCommand(newFlattenCommand())

	return cmd
}

func runBrowser(cmd *cobra.Command, args []string) error {
	basePath := args[0]

	// Check path exists
	if _, err := os.Stat(basePath); os.IsNotExist(err) {
		return fmt.Errorf("path does not exist: %s", basePath)
	}

	fmt.Printf("KBot Explorer - Total Annihilation Asset Browser\n")
	fmt.Printf("Loading archives from: %s\n\n", basePath)

	// Create VFS
	config := &filesystem.Config{
		Extensions:         []string{".hpi", ".ccx", ".gp3", ".ufo"},
		ExcludeDirectories: []string{"Docs"},
		ExcludeExtensions:  []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
		ExcludePrefixes:    []string{"goggame"},
		SkipErrors:         true,
	}

	var err error
	vfs, err = filesystem.NewVirtualFileSystem(basePath, config)
	if err != nil {
		return fmt.Errorf("failed to create VFS: %w", err)
	}
	defer func() { _ = vfs.Close() }()

	// Show stats
	stats := vfs.Stats()
	fmt.Printf("✓ Loaded %d archives\n", stats["archives"])
	fmt.Printf("✓ %d files available\n", stats["total_files"])
	fmt.Printf("✓ %d directories\n\n", stats["directories"])

	// Check if running in server mode
	if serverMode {
		fmt.Printf("Starting web server on port %d...\n", serverPort)
		fmt.Printf("Open http://localhost:%d in your browser\n\n", serverPort)
		return runWebServer(vfs, serverPort)
	}

	// Show archives
	archives := vfs.Archives()
	if len(archives) > 0 {
		fmt.Printf("Archives loaded (%d):\n", len(archives))
		for i, archive := range archives {
			if i < 10 {
				fmt.Printf("  - %s\n", archive)
			} else if i == 10 {
				fmt.Printf("  ... and %d more\n", len(archives)-10)
				break
			}
		}
		fmt.Println()
	}

	currentDir = ""
	fmt.Printf("Type 'help' for available commands\n\n")

	// Interactive loop
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Printf("explorer:%s> ", currentDir)
		
		if !scanner.Scan() {
			break
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		command := parts[0]
		args := parts[1:]

		switch command {
		case "help", "?":
			showHelp()
		
		case "ls":
			handleLS(args)
		
		case "cd":
			handleCD(args)
		
		case "pwd":
			handlePWD()
		
		case "cat":
			handleCAT(args)
		
		case "describe":
			handleDescribe(args)
		
		case "archives":
			handleArchives()
		
		case "stats":
			handleStats()
		
		case "exit", "quit", "q":
			fmt.Println("Goodbye!")
			return nil
		
		default:
			fmt.Printf("Unknown command: %s (type 'help' for available commands)\n", command)
		}
	}

	return scanner.Err()
}

func showHelp() {
	fmt.Println("Available commands:")
	fmt.Println("  ls [path]           - List directory contents")
	fmt.Println("  cd <path>           - Change directory")
	fmt.Println("  pwd                 - Print working directory")
	fmt.Println("  cat <file>          - Display file contents")
	fmt.Println("  describe <file>     - Show metadata for TDF/FBI/GAF files")
	fmt.Println("  archives            - List all loaded archives")
	fmt.Println("  stats               - Show filesystem statistics")
	fmt.Println("  help                - Show this help")
	fmt.Println("  exit/quit           - Exit browser")
}

func handleLS(args []string) {
	// Determine target directory
	targetDir := currentDir
	if len(args) > 0 {
		targetDir = resolvePath(args[0])
	}

	// List directory
	entries, err := vfs.ListDir(targetDir)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	if len(entries) == 0 {
		fmt.Println("(empty directory)")
		return
	}

	// Group by type
	dirs := make([]string, 0)
	files := make([]string, 0)

	for _, entry := range entries {
		fullPath := filepath.Join(targetDir, entry)
		if vfs.IsDir(fullPath) {
			dirs = append(dirs, entry+"/")
		} else {
			files = append(files, entry)
		}
	}

	// Print directories first
	for _, dir := range dirs {
		fmt.Printf("  %s\n", dir)
	}

	// Then files
	for _, file := range files {
		fullPath := filepath.Join(targetDir, file)
		info, err := vfs.Stat(fullPath)
		if err == nil && info.Size > 0 {
			fmt.Printf("  %-40s  %8s\n", file, formatSize(info.Size))
		} else {
			fmt.Printf("  %s\n", file)
		}
	}

	fmt.Printf("\n%d directories, %d files\n", len(dirs), len(files))
}

func handleCD(args []string) {
	if len(args) == 0 {
		currentDir = ""
		return
	}

	targetDir := resolvePath(args[0])

	// Check if it's a directory
	if !vfs.IsDir(targetDir) {
		fmt.Printf("Error: not a directory: %s\n", targetDir)
		return
	}

	currentDir = targetDir
}

func handlePWD() {
	if currentDir == "" {
		fmt.Println("/")
	} else {
		fmt.Printf("/%s\n", currentDir)
	}
}

func handleCAT(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage: cat <file>")
		return
	}

	filePath := resolvePath(args[0])

	// Check if exists
	if !vfs.Exists(filePath) {
		fmt.Printf("Error: file not found: %s\n", filePath)
		return
	}

	// Check if it's a file
	if vfs.IsDir(filePath) {
		fmt.Printf("Error: %s is a directory\n", filePath)
		return
	}

	// Read file
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		return
	}

	// Print contents
	fmt.Print(string(data))
	if len(data) > 0 && data[len(data)-1] != '\n' {
		fmt.Println()
	}
}

func handleDescribe(args []string) {
	if len(args) == 0 {
		fmt.Println("Usage: describe <file>")
		return
	}

	filePath := resolvePath(args[0])

	// Check if exists
	if !vfs.Exists(filePath) {
		fmt.Printf("Error: file not found: %s\n", filePath)
		return
	}

	// Get file info
	info, err := vfs.Stat(filePath)
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	if info.IsDir {
		fmt.Printf("Error: %s is a directory\n", filePath)
		return
	}

	// Determine file type by extension
	ext := strings.ToLower(filepath.Ext(filePath))

	fmt.Printf("File: %s\n", filePath)
	fmt.Printf("Size: %d bytes\n", info.Size)
	fmt.Printf("Source: %s\n", info.Source)
	fmt.Println()

	switch ext {
	case ".fbi", ".tdf", ".gui":
		describeTDF(filePath)
	
	case ".gaf":
		describeGAF(filePath)
	
	case ".hpi", ".ufo", ".ccx", ".gp3":
		describeHPI(filePath)
	
	case ".pcx":
		describePCX(filePath)
	
	case ".cob":
		describeCOB(filePath)
	
	case ".bos", ".h":
		describeBOS(filePath)
	
	case ".ai", ".txt":
		// Check if it's an AI file
		data, err := vfs.ReadFile(filePath)
		if err != nil {
			fmt.Printf("Error reading file: %v\n", err)
			return
		}
		if ai.IsAIFile(data) {
			describeAI(filePath, data)
		} else if ext == ".txt" {
			fmt.Printf("File type: .txt (not an AI file)\n")
		} else {
			fmt.Printf("File type: %s (no metadata parser available)\n", ext)
		}
	
	default:
		fmt.Printf("File type: %s (no metadata parser available)\n", ext)
	}
}

func describeTDF(filePath string) {
	// Read file
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		return
	}

	// Parse TDF
	doc, err := tdf.ParseString(string(data))
	if err != nil {
		fmt.Printf("Error parsing TDF: %v\n", err)
		return
	}

	sections := doc.Sections()
	fmt.Printf("Format: TDF/FBI\n")
	fmt.Printf("Sections: %d\n\n", len(sections))

	// Show section details
	for _, section := range sections {
		fmt.Printf("[%s]\n", section.Name())
		
		fields := section.Fields()
		if len(fields) > 0 {
			fmt.Printf("  Fields: %d\n", len(fields))
			
			// Show first few fields
			count := 0
			for _, field := range fields {
				if count < 10 {
					value := field.Value()
					if len(value) > 50 {
						value = value[:50] + "..."
					}
					fmt.Printf("    %s = %s\n", field.Key(), value)
					count++
				}
			}
			if len(fields) > 10 {
				fmt.Printf("    ... and %d more fields\n", len(fields)-10)
			}
		}
		fmt.Println()
	}

	// Special handling for FBI files (unit definitions)
	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == ".fbi" || ext == ".gui" {
		if unitInfo := doc.Section("UNITINFO"); unitInfo != nil {
			fmt.Println("Unit Information:")
			
			name := unitInfo.String("UnitName")
			if name != "" {
				fmt.Printf("  Name: %s\n", name)
			}
			
			desc := unitInfo.String("Description")
			if desc != "" {
				fmt.Printf("  Description: %s\n", desc)
			}
			
			side := unitInfo.String("Side")
			if side != "" {
				fmt.Printf("  Side: %s\n", side)
			}
			
			metal := unitInfo.Int("BuildCostMetal")
			if metal > 0 {
				fmt.Printf("  Metal Cost: %d\n", metal)
			}
			
			energy := unitInfo.Int("BuildCostEnergy")
			if energy > 0 {
				fmt.Printf("  Energy Cost: %d\n", energy)
			}
			
			hp := unitInfo.Int("MaxDamage")
			if hp > 0 {
				fmt.Printf("  Hit Points: %d\n", hp)
			}
			
			speed := unitInfo.Float("MaxVelocity")
			if speed > 0 {
				fmt.Printf("  Max Speed: %.2f\n", speed)
			}
		}
	}
}

func describeGAF(filePath string) {
	// Read full file from VFS
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		return
	}

	// Parse GAF using in-memory reader (no temp file!)
	bytesReader := bytes.NewReader(data)
	reader, err := gaf.LoadFromReader(bytesReader)
	if err != nil {
		fmt.Printf("Error opening GAF: %v\n", err)
		return
	}
	defer func() { _ = reader.Close() }()

	header := reader.Header()
	sequences, err := reader.ReadSequences()
	if err != nil {
		fmt.Printf("Error reading sequences: %v\n", err)
		return
	}

	fmt.Printf("Format: GAF (Graphics Animation File)\n")
	fmt.Printf("Version: 0x%08X\n", header.Version)
	fmt.Printf("Sequences: %d\n\n", header.SequenceCount)

	totalFrames := 0
	for _, seq := range sequences {
		totalFrames += len(seq.Frames)
	}
	fmt.Printf("Total Frames: %d\n\n", totalFrames)

	// Show sequence details
	for i, seq := range sequences {
		fmt.Printf("[%d] %s\n", i, seq.Name)
		fmt.Printf("    Frames: %d\n", len(seq.Frames))
		
		if len(seq.Frames) > 0 {
			// Show first frame details
			frame := seq.Frames[0]
			fmt.Printf("    Dimensions: %dx%d\n", frame.Width, frame.Height)
			fmt.Printf("    Origin: (%d, %d)\n", frame.OriginX, frame.OriginY)
			fmt.Printf("    Transparency Index: %d\n", frame.TransparencyIndex)
			fmt.Printf("    Frame Duration: %d ticks (%.2f sec)\n", 
				frame.Duration, float64(frame.Duration)/30.0)
			
			// Show frame size variation if any
			if len(seq.Frames) > 1 {
				minW, maxW := frame.Width, frame.Width
				minH, maxH := frame.Height, frame.Height
				for _, f := range seq.Frames[1:] {
					if f.Width < minW {
						minW = f.Width
					}
					if f.Width > maxW {
						maxW = f.Width
					}
					if f.Height < minH {
						minH = f.Height
					}
					if f.Height > maxH {
						maxH = f.Height
					}
				}
				if minW != maxW || minH != maxH {
					fmt.Printf("    Size Range: %dx%d to %dx%d\n", minW, minH, maxW, maxH)
				}
			}
		}
		fmt.Println()
	}
}

func describeHPI(filePath string) {
	// For HPI archives, we'd need to open the physical file
	// This is more complex as it's not in the VFS
	fmt.Printf("Format: HPI/UFO/CCX archive\n")
	fmt.Printf("(Archive metadata requires direct file access)\n")
	
	// Try to get basic info
	info, err := vfs.Stat(filePath)
	if err == nil {
		fmt.Printf("Size: %d bytes\n", info.Size)
	}
}

func handleArchives() {
	archives := vfs.Archives()
	fmt.Printf("Loaded Archives (%d):\n\n", len(archives))
	
	for _, archive := range archives {
		fmt.Printf("  %s\n", archive)
	}
}

func handleStats() {
	stats := vfs.Stats()
	
	fmt.Println("Filesystem Statistics:")
	fmt.Println()
	fmt.Printf("  Base Path: %s\n", stats["base_path"])
	fmt.Printf("  Archives: %d\n", stats["archives"])
	fmt.Printf("  Total Files: %d\n", stats["total_files"])
	fmt.Printf("  Archive Files: %d\n", stats["archive_files"])
	fmt.Printf("  Physical Files: %d\n", stats["physical_files"])
	fmt.Printf("  Directories: %d\n", stats["directories"])
	fmt.Println()
	
	archives := stats["archive_names"].([]string)
	if len(archives) > 0 {
		fmt.Println("Loaded Archives:")
		for _, archive := range archives {
			fmt.Printf("  - %s\n", archive)
		}
	}
}

// resolvePath resolves a path relative to current directory
func resolvePath(path string) string {
	// Normalize path separators
	path = filepath.ToSlash(path)
	
	// Handle absolute paths (starts with /)
	if strings.HasPrefix(path, "/") {
		// Remove leading slash and return
		result := strings.TrimPrefix(path, "/")
		// Handle root path specially
		if result == "" {
			return ""
		}
		return result
	}

	// Handle special paths
	if path == ".." {
		if currentDir == "" {
			return ""
		}
		parent := filepath.Dir(currentDir)
		if parent == "." {
			return ""
		}
		return parent
	}

	if path == "." {
		return currentDir
	}

	// Resolve relative path
	if currentDir == "" {
		return path
	}

	return filepath.Join(currentDir, path)
}

// formatSize formats bytes into human-readable size
func formatSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

func describePCX(filePath string) {
	reader, err := vfs.Open(filePath)
	if err != nil {
		fmt.Printf("Error: failed to open file: %v\n", err)
		return
	}
	defer func() { _ = reader.Close() }()

	pcxReader, err := pcx.LoadFromReader(reader)
	if err != nil {
		fmt.Printf("Error: failed to read PCX: %v\n", err)
		return
	}

	fmt.Println("Format: PCX Image")
	fmt.Printf("Resolution: %dx%d pixels\n", pcxReader.Width(), pcxReader.Height())
	fmt.Printf("Bit Depth: %d-bit\n", pcxReader.BitsPerPixel())
	
	header := pcxReader.Header()
	fmt.Printf("Color Planes: %d\n", header.NumPlanes)
	
	// Determine color type
	bpp := pcxReader.BitsPerPixel()
	colorType := "Unknown"
	if bpp == 1 {
		colorType = "Monochrome"
	} else if bpp == 4 {
		colorType = "16-color"
	} else if bpp == 8 && header.NumPlanes == 1 {
		colorType = "256-color (paletted)"
	} else if bpp == 24 && header.NumPlanes == 3 {
		colorType = "True Color (RGB)"
	}
	fmt.Printf("Color Type: %s\n", colorType)
}

func describeAI(filePath string, data []byte) {
	aiFile, err := ai.Parse(data)
	if err != nil {
		fmt.Printf("Error parsing AI file: %v\n", err)
		return
	}

	fmt.Printf("Format: Total Annihilation AI Profile\n")
	fmt.Printf("Plans: %d\n\n", len(aiFile.Plans))

	for _, plan := range aiFile.Plans {
		fmt.Printf("=== %s Plan ===\n", cases.Title(language.English).String(strings.ToLower(plan.Name)))
		
		if len(plan.Weights) > 0 {
			fmt.Printf("\nUnit Build Weights:\n")
			maxWeight := 0.0
			for _, w := range plan.Weights {
				if w.Weight > maxWeight {
					maxWeight = w.Weight
				}
			}
			
			for _, w := range plan.Weights {
				barWidth := int((w.Weight / maxWeight) * 30)
				bar := strings.Repeat("█", barWidth)
				fmt.Printf("  %-30s %6.1f %s\n", w.UnitName, w.Weight, bar)
			}
		}
		
		if len(plan.Limits) > 0 {
			fmt.Printf("\nBuild Limits:\n")
			for _, l := range plan.Limits {
				limit := fmt.Sprintf("%d", l.Maximum)
				if l.Maximum == -1 {
					limit = "∞"
				}
				fmt.Printf("  %-30s %s\n", l.UnitName, limit)
			}
		}
		
		fmt.Println()
	}
}

func describeCOB(filePath string) {
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		return
	}

	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		fmt.Printf("Error parsing COB: %v\n", err)
		return
	}

	fmt.Printf("Format: COB (Compiled BOS Script)\n")
	fmt.Printf("Version: %d\n", cob.VersionSignature)
	fmt.Printf("Scripts: %d\n", cob.NumScripts)
	fmt.Printf("Pieces: %d\n", cob.NumPieces)
	fmt.Printf("Code Length: %d bytes\n", len(cob.Code))
	fmt.Printf("Static Variables: %d\n", cob.Unknown1)
	fmt.Println()

	if len(cob.PieceNames) > 0 {
		fmt.Println("Pieces:")
		for i, name := range cob.PieceNames {
			if i < 20 {
				fmt.Printf("  [%2d] %s\n", i, name)
			}
		}
		if len(cob.PieceNames) > 20 {
			fmt.Printf("  ... and %d more\n", len(cob.PieceNames)-20)
		}
		fmt.Println()
	}

	if len(cob.ScriptNames) > 0 {
		fmt.Println("Scripts:")
		for i, name := range cob.ScriptNames {
			if i < 20 && name != "" {
				fmt.Printf("  [%2d] %s\n", i, name)
			}
		}
		if len(cob.ScriptNames) > 20 {
			fmt.Printf("  ... and %d more\n", len(cob.ScriptNames)-20)
		}
	}
}

func describeBOS(filePath string) {
	data, err := vfs.ReadFile(filePath)
	if err != nil {
		fmt.Printf("Error reading file: %v\n", err)
		return
	}

	ext := strings.ToLower(filepath.Ext(filePath))
	if ext == ".h" {
		fmt.Printf("Format: BOS Header File\n")
	} else {
		fmt.Printf("Format: BOS Script\n")
	}

	lines := strings.Split(string(data), "\n")
	fmt.Printf("Lines: %d\n", len(lines))
	fmt.Printf("Size: %d bytes\n", len(data))
	
	// Count non-empty, non-comment lines
	codeLines := 0
	commentLines := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") {
			commentLines++
		} else {
			codeLines++
		}
	}
	
	fmt.Printf("Code Lines: %d\n", codeLines)
	fmt.Printf("Comment Lines: %d\n", commentLines)
}
