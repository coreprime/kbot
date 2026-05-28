package studio

import (
	"io/fs"
	"strings"
	"testing"
)

// TestShaderAssetsEmbedded asserts that the //go:embed directive in
// studio.go covers every shader file the renderer needs at runtime.
// If a file ever moves and the embed pattern can't see it any more,
// the binary still builds - shaders just disappear at first fetch
// from the browser, which is a painful failure mode to debug.  This
// test catches it at `task test` time instead.
func TestShaderAssetsEmbedded(t *testing.T) {
	required := []string{
		"web/game3d/shader-loader.js",
		"web/game3d/shaders/lib/sea-waves.glsl",
		"web/game3d/shaders/main/main.vert",
		"web/game3d/shaders/main/main.frag",
		"web/game3d/shaders/sky/sky.vert",
		"web/game3d/shaders/sky/sky.frag",
		"web/game3d/shaders/ground/ground.vert",
		"web/game3d/shaders/ground/ground.frag",
		"web/game3d/shaders/shadow/shadow.vert",
		"web/game3d/shaders/shadow/shadow.frag",
		"web/game3d/shaders/wire/wire.vert",
		"web/game3d/shaders/wire/wire.frag",
		"web/game3d/shaders/dof/dof.vert",
		"web/game3d/shaders/dof/dof.frag",
		"web/game3d/shaders/particles/particles.vert",
		"web/game3d/shaders/particles/particles.frag",
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
	shaderFiles, err := fs.Glob(webFS, "web/game3d/shaders/*/*")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(shaderFiles) == 0 {
		t.Fatal("no shader files found under web/game3d/shaders/")
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
