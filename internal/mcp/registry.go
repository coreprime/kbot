package mcp

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
)

// Registry is the set of named game-data folders the MCP server knows about.
// The first folder registered is treated as the default and is used when a
// tool call does not name one explicitly.
type Registry struct {
	mu    sync.Mutex
	items map[string]*GameData
	order []string
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{items: map[string]*GameData{}}
}

// Add registers a game-data folder.  Spec may be "PATH" or "NAME=PATH".
// When the name is omitted it is derived from the basename of PATH.
func (r *Registry) Add(spec string) (*GameData, error) {
	if spec == "" {
		return nil, fmt.Errorf("game-data spec is empty")
	}

	name, path := splitGameDataSpec(spec)
	if path == "" {
		return nil, fmt.Errorf("game-data spec %q has no path", spec)
	}
	if name == "" {
		name = defaultGameDataName(path)
	}

	return r.AddNamed(name, path, WithSource("flag"))
}

// AddNamed registers a game-data folder with an explicit name and optional
// metadata.  Used by the kbot ctx loader to attach game/version info.
func (r *Registry) AddNamed(name, path string, opts ...GameDataOption) (*GameData, error) {
	if name == "" {
		return nil, fmt.Errorf("registry: name is required")
	}
	if path == "" {
		return nil, fmt.Errorf("registry %q: path is required", name)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.items[name]; exists {
		return nil, fmt.Errorf("duplicate game-data name %q", name)
	}

	gd, err := NewGameData(name, path, opts...)
	if err != nil {
		return nil, err
	}
	r.items[name] = gd
	r.order = append(r.order, name)
	return gd, nil
}

// Default returns the first registered game-data folder, or nil if none.
func (r *Registry) Default() *GameData {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.order) == 0 {
		return nil
	}
	return r.items[r.order[0]]
}

// Get returns the game-data with the given name.  If name is empty the
// default is returned.  Returns an error if the named entry does not exist
// (or if no default is configured and name is empty).
func (r *Registry) Get(name string) (*GameData, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if name == "" {
		if len(r.order) == 0 {
			return nil, nil
		}
		return r.items[r.order[0]], nil
	}
	gd, ok := r.items[name]
	if !ok {
		return nil, fmt.Errorf("unknown game-data folder %q (known: %s)",
			name, strings.Join(r.order, ", "))
	}
	return gd, nil
}

// Names returns the registered names in insertion order.
func (r *Registry) Names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

// Close releases every registered game-data folder.
func (r *Registry) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var firstErr error
	for _, gd := range r.items {
		if err := gd.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// splitGameDataSpec splits "NAME=PATH" into ("NAME","PATH"); a plain "PATH"
// returns ("","PATH").  Whitespace is trimmed from both halves.
func splitGameDataSpec(spec string) (name, path string) {
	if i := strings.Index(spec, "="); i >= 0 {
		return strings.TrimSpace(spec[:i]), strings.TrimSpace(spec[i+1:])
	}
	return "", strings.TrimSpace(spec)
}

// defaultGameDataName returns a name derived from path's basename, sanitised
// so it makes sense as an identifier the model will pass back.
func defaultGameDataName(path string) string {
	base := filepath.Base(filepath.Clean(path))
	base = strings.TrimSuffix(base, filepath.Ext(base))
	if base == "" || base == "." || base == "/" {
		return "default"
	}
	return base
}
