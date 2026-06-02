package studio

import (
	"io/fs"
	"strings"
	"testing"
)

// shaderRoot is where the Vite build copies the GLSL tree verbatim inside
// the embedded bundle.  shader-loader fetches it at /game3d/shaders/ and the
// studio serves it straight from this embedded path.
const shaderRoot = "web/dist/game3d/shaders"

// requireBuiltBundle skips a test when the Vite bundle hasn't been produced
// yet (a fresh checkout embeds only web/dist/.gitkeep).  The canonical flow
// — `task build` then `task test` — always builds first, so CI still runs
// these guards; a bare `go test ./...` without a prior build skips instead
// of failing on a missing artifact.
func requireBuiltBundle(t *testing.T) {
	t.Helper()
	if _, err := fs.Stat(webFS, shaderRoot); err != nil {
		t.Skipf("studio web bundle not built (run `task build`): %v", err)
	}
}

// TestShaderAssetsEmbedded asserts that the //go:embed directive in
// studio.go covers every shader file the renderer needs at runtime.
// If a file ever moves and the embed pattern can't see it any more,
// the binary still builds - shaders just disappear at first fetch
// from the browser, which is a painful failure mode to debug.  This
// test catches it at `task test` time instead.
func TestShaderAssetsEmbedded(t *testing.T) {
	requireBuiltBundle(t)
	required := []string{
		shaderRoot + "/lib/sea-waves.glsl",
		shaderRoot + "/main/main.vert",
		shaderRoot + "/main/main.frag",
		shaderRoot + "/sky/sky.vert",
		shaderRoot + "/sky/sky.frag",
		shaderRoot + "/ground/ground.vert",
		shaderRoot + "/ground/ground.frag",
		shaderRoot + "/shadow/shadow.vert",
		shaderRoot + "/shadow/shadow.frag",
		shaderRoot + "/wire/wire.vert",
		shaderRoot + "/wire/wire.frag",
		shaderRoot + "/dof/dof.vert",
		shaderRoot + "/dof/dof.frag",
		shaderRoot + "/particles/particles.vert",
		shaderRoot + "/particles/particles.frag",
	}
	for _, path := range required {
		data, err := fs.ReadFile(webFS, path)
		if err != nil {
			t.Errorf("embed missing %q: %v", path, err)
			continue
		}
		if len(data) == 0 {
			t.Errorf("embedded %q is empty", path)
		}
	}
}

// TestShaderIncludeAnchorsExist guards against an include directive
// in a shader referring to a missing helper.  We don't compile the
// shaders here (no GL context), but we can at least confirm that
// every #include resolves to a file the loader will be able to find.
func TestShaderIncludeAnchorsExist(t *testing.T) {
	requireBuiltBundle(t)
	shaderFiles, err := fs.Glob(webFS, shaderRoot+"/*/*")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(shaderFiles) == 0 {
		t.Fatalf("no shader files found under %s/", shaderRoot)
	}
	for _, path := range shaderFiles {
		body, err := fs.ReadFile(webFS, path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "#include") {
				continue
			}
			// #include "../lib/sea-waves.glsl" -> "../lib/sea-waves.glsl"
			start := strings.Index(line, "\"")
			end := strings.LastIndex(line, "\"")
			if start == -1 || end <= start {
				t.Errorf("%s: malformed include line %q", path, line)
				continue
			}
			ref := line[start+1 : end]
			// Resolve relative to the shader file's directory.
			dir := path[:strings.LastIndex(path, "/")]
			resolved := joinRel(dir, ref)
			if _, err := fs.ReadFile(webFS, resolved); err != nil {
				t.Errorf("%s: include %q -> %q not embedded: %v", path, ref, resolved, err)
			}
		}
	}
}

// joinRel performs the same path resolution the JS loader does -
// joining a base directory with a relative path and collapsing any
// `..` segments.  Lives in the test because there's no other caller
// in the studio package that needs this kind of path math.
func joinRel(base, rel string) string {
	parts := strings.Split(base, "/")
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
			continue
		}
		if seg == "." || seg == "" {
			continue
		}
		parts = append(parts, seg)
	}
	return strings.Join(parts, "/")
}
