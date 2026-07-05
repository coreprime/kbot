package studio

import (
	"io/fs"
	"strings"
	"testing"
)

// requireBuiltBundle skips a test when the Vite bundle hasn't been produced
// yet (a fresh checkout embeds only web/dist/.gitkeep).  The canonical flow
// — `task build` then `task test` — always builds first, so CI still runs
// these guards; a bare `go test ./...` without a prior build skips instead
// of failing on a missing artifact.
func requireBuiltBundle(t *testing.T) {
	t.Helper()
	entries, err := fs.ReadDir(webFS, "web/dist/assets")
	if err != nil || len(entries) == 0 {
		t.Skipf("studio web bundle not built (run `task build`): %v", err)
	}
}

// TestShaderSourcesBundled asserts that the renderer's GLSL made it into
// the embedded web bundle.  The shaders live in @coreprime/kbot-game3d, embedded
// into its generated shader-sources module at package build time and then
// rolled into the Vite output — if that chain breaks (package not built,
// generated module missed by the bundler) the studio ships a renderer
// whose init() fails on every shader, which is a painful failure mode to
// debug.  This test catches it at `task test` time instead by looking for
// distinctive GLSL anchors in the bundled JS.
func TestShaderSourcesBundled(t *testing.T) {
	requireBuiltBundle(t)
	entries, err := fs.ReadDir(webFS, "web/dist/assets")
	if err != nil {
		t.Fatalf("read embedded assets: %v", err)
	}
	// Anchors: one per load-bearing piece of the chain, chosen to be
	// strings that only occur in the GLSL sources / shader manifest.
	anchors := []string{
		"main/main.vert",     // the shader-loader manifest keys
		"lib/sea-waves.glsl", // the shared include's path key
		"gl_FragColor",       // any fragment shader body
	}
	found := make(map[string]bool, len(anchors))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".js") {
			continue
		}
		body, err := fs.ReadFile(webFS, "web/dist/assets/"+e.Name())
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		for _, a := range anchors {
			if strings.Contains(string(body), a) {
				found[a] = true
			}
		}
	}
	for _, a := range anchors {
		if !found[a] {
			t.Errorf("embedded web bundle carries no shader anchor %q — was @coreprime/kbot-game3d built before the Vite bundle?", a)
		}
	}
}
