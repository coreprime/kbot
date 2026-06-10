// Package studio implements KBot Studio — a web-based map editor for
// Total Annihilation and TA: Kingdoms.  It mounts a VFS over a TA install (or
// the active kbot context), serves a browser UI, and bundles the user's work
// into a downloadable HPI archive when they hit save.
package studio

import (
	"embed"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coreprime/kbot/filesystem"
	"github.com/spf13/cobra"
)

// Embed the Vite build output for the studio web app.  The bundle is produced
// by `task build` (vite build → web/dist) before the binary is compiled; a
// committed web/dist/.gitkeep keeps this package compiling on a fresh checkout
// before that build has run.
//
//go:embed all:web/dist
var webFS embed.FS

var serverPort int

// NewCommand returns the `kbot studio` subcommand.
func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "studio [path]",
		Short: "Web-based map editor (KBot Studio)",
		Long: `KBot Studio is a browser-based map editor for Total
Annihilation and TA: Kingdoms maps.  It mounts a TA install (so you can drag
sections and features into the world), and bundles your work into a
downloadable .hpi archive containing maps/<name>.tnt and maps/<name>.ota.

When <path> is omitted, the active kbot context (see 'kbot ctx') is mounted.

Open the URL printed at startup in a browser, pick an initial map size,
and start designing.`,
		Args: cobra.MaximumNArgs(1),
		RunE: runStudio,
	}
	cmd.Flags().IntVarP(&serverPort, "port", "p", 8100, "Web server port (default 8100)")
	return cmd
}

func runStudio(_ *cobra.Command, args []string) error {
	mgr := newWorkspaceManager(".cache")

	fmt.Printf("KBot Studio — TA/TAK content editor\n\n")

	// `kbot studio <path>` pre-opens that path as a quick "local" workspace;
	// otherwise the picker lists the configured contexts and recent workspaces.
	if len(args) > 0 && args[0] != "" {
		path := args[0]
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return fmt.Errorf("path does not exist: %s", path)
		}
		sess, err := mgr.openLocalPath("local", "Local", path)
		if err != nil {
			return fmt.Errorf("failed to open %s: %w", path, err)
		}
		if isTerminal(os.Stdout) {
			go sess.reportPreloadProgress()
		}
		fmt.Printf("Opened %s\n  → http://localhost:%d/workspaces/local/\n\n", path, serverPort)
	}

	mux := http.NewServeMux()
	mgr.register(mux)

	addr := fmt.Sprintf(":%d", serverPort)
	fmt.Printf("KBot Studio is running:\n")
	fmt.Printf("  Open  http://localhost:%d  (workspace picker)\n", serverPort)
	fmt.Printf("  Ctrl+C to stop\n\n")
	return http.ListenAndServe(addr, mux)
}

// studioFSConfig returns the VFS config the studio mounts contexts with:
// TA archive extensions, excluding the non-asset files an install ships.
func studioFSConfig() *filesystem.Config {
	return &filesystem.Config{
		Extensions:         []string{".hpi", ".ccx", ".gp3", ".ufo"},
		ExcludeDirectories: []string{"Docs"},
		ExcludeExtensions:  []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
		ExcludePrefixes:    []string{"goggame"},
		SkipErrors:         true,
	}
}

// isTerminal returns true when f appears to be a character device
// (i.e., a real TTY).  Pipes and files come back false so the progress
// bar never garbles CI logs or piped output.
func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

// reportPreloadProgress draws a single-line progress bar to stdout
// until the preload goroutine flips finished=true.  Redraws every
// 100 ms using carriage return + clear-to-EOL; the line is cleared
// on completion so the server's normal output isn't garbled.
func (sess *Session) reportPreloadProgress() {
	const barWidth = 24
	const clearLine = "\r\033[2K"
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		phase, done, total, finished := sess.preloadProgress.snapshot()
		if finished {
			_, _ = fmt.Fprint(os.Stdout, clearLine+"✓ Asset cache ready\n")
			return
		}
		if total == 0 {
			continue
		}
		ratio := float64(done) / float64(total)
		if ratio > 1 {
			ratio = 1
		}
		fill := int(ratio * float64(barWidth))
		bar := strings.Repeat("█", fill) + strings.Repeat("░", barWidth-fill)
		_, _ = fmt.Fprintf(os.Stdout, "%sCaching %s: [%s] %d/%d (%d%%)", clearLine, phase, bar, done, total, int(ratio*100))
	}
}

func contentTypeFor(name string) string {
	switch filepath.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		// .mjs is the canonical ESM extension; browsers enforce strict
		// MIME checking on <script type="module"> imports and reject
		// anything other than a JS MIME (chrome treats application/
		// octet-stream as "not a module").  Both extensions go through
		// the same handler since the JS itself is identical.
		return "application/javascript"
	case ".css":
		return "text/css"
	case ".wasm":
		// WebAssembly.instantiateStreaming rejects any response whose
		// Content-Type isn't application/wasm, so the engine module must
		// be served with this exact type.
		return "application/wasm"
	case ".json":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".glsl", ".vert", ".frag", ".vs", ".fs":
		// GLSL source files served as plain text so the browser's
		// fetch().text() returns the raw shader body.  The renderer's
		// shader-loader.js then runs the #include preprocessor before
		// handing the text to glShaderSource.
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}
