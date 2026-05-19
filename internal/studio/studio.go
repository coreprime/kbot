// Package studio implements KBot Studio — a web-based map editor for
// Total Annihilation and TA: Kingdoms.  It mounts a VFS over a TA install (or
// the active kbot context), serves a browser UI, and bundles the user's work
// into a downloadable HPI archive when they hit save.
package studio

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
	"github.com/spf13/cobra"
)

// Embed the studio web assets explicitly so a stray node_modules / dotfile
// added during local development doesn't bloat the binary.
//
//go:embed web/index.html web/studio.css web/studio.js
var webFS embed.FS

var (
	vfs        *filesystem.VirtualFileSystem
	serverPort int
)

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
	basePath, note, err := resolveContextPath(args)
	if err != nil {
		return err
	}
	if note != "" {
		fmt.Println(note)
	}
	if _, err := os.Stat(basePath); os.IsNotExist(err) {
		return fmt.Errorf("path does not exist: %s", basePath)
	}

	fmt.Printf("KBot Studio — TA/TAK map editor\n")
	fmt.Printf("Loading archives from: %s\n\n", basePath)

	config := &filesystem.Config{
		Extensions:         []string{".hpi", ".ccx", ".gp3", ".ufo"},
		ExcludeDirectories: []string{"Docs"},
		ExcludeExtensions:  []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
		ExcludePrefixes:    []string{"goggame"},
		SkipErrors:         true,
	}
	vfs, err = filesystem.NewVirtualFileSystem(basePath, config)
	if err != nil {
		return fmt.Errorf("failed to create VFS: %w", err)
	}
	defer func() { _ = vfs.Close() }()

	stats := vfs.Stats()
	fmt.Printf("✓ Loaded %d archives\n", stats["archives"])
	fmt.Printf("✓ %d files available\n\n", stats["total_files"])

	mux := http.NewServeMux()
	registerAPI(mux)
	registerStatic(mux)

	addr := fmt.Sprintf(":%d", serverPort)
	fmt.Printf("KBot Studio is running:\n")
	fmt.Printf("  Open  http://localhost:%d  in your browser\n", serverPort)
	fmt.Printf("  Ctrl+C to stop\n\n")
	return http.ListenAndServe(addr, mux)
}

// resolveContextPath mirrors the logic the explorer uses to pick a working
// directory: explicit arg first, then active kbot context.
func resolveContextPath(args []string) (string, string, error) {
	if len(args) > 0 && args[0] != "" {
		return args[0], "", nil
	}
	cfg, err := kbotctx.Load()
	if err != nil {
		return "", "", err
	}
	alias, ctx, src, ok := cfg.Active()
	if !ok {
		if alias != "" && src == "env" {
			return "", "", fmt.Errorf("%s=%s names an unknown kbot context (run `kbot ctx list`)", kbotctx.EnvVar, alias)
		}
		return "", "", fmt.Errorf("no path provided and no kbot context configured (run `kbot ctx add` or pass an explicit path)")
	}
	note := fmt.Sprintf("Using context %q (%s)", alias, ctx.Path)
	if src == "env" {
		note = fmt.Sprintf("Using context %q via %s (%s)", alias, kbotctx.EnvVar, ctx.Path)
	}
	return ctx.Path, note, nil
}

// registerStatic serves the embedded web app.  We read files out of the
// embed.FS directly rather than using http.FileServer, which auto-redirects
// `/index.html` back to `/` and trips up our root handler.
func registerStatic(mux *http.ServeMux) {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(fmt.Sprintf("studio: embed sub-fs: %v", err))
	}
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
		if clean == "" || clean == "." {
			clean = "index.html"
		}
		data, err := fs.ReadFile(sub, clean)
		if err != nil {
			// SPA fallback — unknown routes get index.html.
			data, err = fs.ReadFile(sub, "index.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			clean = "index.html"
		}
		w.Header().Set("Content-Type", contentTypeFor(clean))
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(data)
	}))
}

func contentTypeFor(name string) string {
	switch filepath.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js":
		return "application/javascript"
	case ".css":
		return "text/css"
	case ".json":
		return "application/json"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	}
	return "application/octet-stream"
}
