// Package kbotctx manages named working-directory contexts for kbot.
//
// A context bundles a path to a Total Annihilation install (packed or
// flattened), the game it represents, and an optional version label.
// Contexts are persisted to a JSON file at $HOME/.kbot so that every
// VFS-backed kbot command can pick up the right install without the
// user having to repeat the path.
//
// The active context is whichever alias is named in the file's
// "current" field. The KBOT_CONTEXT environment variable overrides it
// for the current process.
package kbotctx

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ConfigFileName is the basename used for the kbot config file.
const ConfigFileName = ".kbot"

// EnvVar is the environment variable that overrides the persisted
// "current" context for the running process.
const EnvVar = "KBOT_CONTEXT"

// Game identifies which game an install holds.
const (
	GameTotalA     = "totala"
	GameTAKingdoms = "takingdoms"
	GameCustom     = "custom"
)

// ValidGames lists the accepted values for Context.Game.
var ValidGames = []string{GameTotalA, GameTAKingdoms, GameCustom}

// Context describes a single registered install.
type Context struct {
	Path    string `json:"path"`
	Game    string `json:"game"`
	Version string `json:"version,omitempty"`

	// Parent is the alias of another context this one is layered on top of.
	// When set, a VFS built for this context resolves through the parent
	// chain (base game → expansion → mod), with this context overriding its
	// parents. Empty for a root context.
	Parent string `json:"parent,omitempty"`
}

// WorkspaceRef is a lightweight pointer to an editing workspace on disk. The
// authoritative metadata lives in the workspace's manifest; this index just
// lets tools (e.g. the studio picker) list recently used workspaces.
type WorkspaceRef struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Base string `json:"base"`
}

// Config is the on-disk shape of the kbot config file.
type Config struct {
	Current    string             `json:"current,omitempty"`
	Contexts   map[string]Context `json:"contexts,omitempty"`
	Workspaces []WorkspaceRef     `json:"workspaces,omitempty"`

	path string // resolved location on disk, not serialised
}

// DefaultPath returns the path to the kbot config file
// ($HOME/.kbot). It does not check that the file exists.
func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home directory: %w", err)
	}
	return filepath.Join(home, ConfigFileName), nil
}

// Load reads the kbot config from $HOME/.kbot. A missing file is
// treated as an empty config so callers can add the first context
// without bootstrapping.
func Load() (*Config, error) {
	p, err := DefaultPath()
	if err != nil {
		return nil, err
	}
	return loadFrom(p)
}

func loadFrom(path string) (*Config, error) {
	cfg := &Config{
		Contexts: map[string]Context{},
		path:     path,
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return cfg, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if len(data) == 0 {
		return cfg, nil
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if cfg.Contexts == nil {
		cfg.Contexts = map[string]Context{}
	}
	cfg.path = path
	return cfg, nil
}

// Save writes the config back to its original path with restrictive
// permissions (0600) since it stores filesystem locations.
func (c *Config) Save() error {
	if c.path == "" {
		p, err := DefaultPath()
		if err != nil {
			return err
		}
		c.path = p
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	if err := os.WriteFile(c.path, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", c.path, err)
	}
	return nil
}

// Aliases returns the registered context aliases in sorted order.
func (c *Config) Aliases() []string {
	out := make([]string, 0, len(c.Contexts))
	for k := range c.Contexts {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Add registers a new context. It rejects duplicate aliases unless
// replace is true.
func (c *Config) Add(alias string, ctx Context, replace bool) error {
	if err := validateAlias(alias); err != nil {
		return err
	}
	if err := validateGame(ctx.Game); err != nil {
		return err
	}
	if ctx.Path == "" {
		return errors.New("path is required")
	}
	abs, err := filepath.Abs(ctx.Path)
	if err != nil {
		return fmt.Errorf("resolve path: %w", err)
	}
	ctx.Path = abs

	if c.Contexts == nil {
		c.Contexts = map[string]Context{}
	}
	prev, had := c.Contexts[alias]
	if had && !replace {
		return fmt.Errorf("context %q already exists (pass --replace to overwrite)", alias)
	}
	c.Contexts[alias] = ctx
	// Validate the parent chain (existence, no cycles, compatible games).
	if _, err := c.ResolveChain(alias); err != nil {
		if had {
			c.Contexts[alias] = prev
		} else {
			delete(c.Contexts, alias)
		}
		return err
	}
	// First context becomes current automatically.
	if c.Current == "" {
		c.Current = alias
	}
	return nil
}

// Delete removes a context. Returns an error if the alias is unknown or if
// another context still names it as a parent. If the deleted context was
// current, Current is cleared.
func (c *Config) Delete(alias string) error {
	if _, exists := c.Contexts[alias]; !exists {
		return fmt.Errorf("context %q not found", alias)
	}
	if children := c.childrenOf(alias); len(children) > 0 {
		sort.Strings(children)
		return fmt.Errorf("context %q is the parent of %s; reparent or delete those first",
			alias, strings.Join(children, ", "))
	}
	delete(c.Contexts, alias)
	if c.Current == alias {
		c.Current = ""
	}
	return nil
}

// childrenOf returns the aliases of contexts that name alias as their parent.
func (c *Config) childrenOf(alias string) []string {
	var children []string
	for name, ctx := range c.Contexts {
		if ctx.Parent == alias {
			children = append(children, name)
		}
	}
	return children
}

// ResolveChain returns the context aliases from alias up to its root parent,
// highest-priority first (alias itself, then its parent, and so on). It fails
// if a parent is missing, a cycle exists, or the chain mixes incompatible
// games (e.g. totala under takingdoms; custom is compatible with either).
func (c *Config) ResolveChain(alias string) ([]string, error) {
	if _, ok := c.Contexts[alias]; !ok {
		return nil, fmt.Errorf("context %q not found", alias)
	}
	var (
		chain    []string
		seen     = map[string]bool{}
		concrete string
		cur      = alias
	)
	for cur != "" {
		if seen[cur] {
			return nil, fmt.Errorf("context parent cycle detected at %q", cur)
		}
		seen[cur] = true
		ctx, ok := c.Contexts[cur]
		if !ok {
			return nil, fmt.Errorf("parent context %q not found", cur)
		}
		chain = append(chain, cur)
		if ctx.Game != "" && ctx.Game != GameCustom {
			if concrete != "" && concrete != ctx.Game {
				return nil, fmt.Errorf("context chain mixes incompatible games (%s and %s)", concrete, ctx.Game)
			}
			concrete = ctx.Game
		}
		cur = ctx.Parent
	}
	return chain, nil
}

// SetParent sets (or clears, when parent is "") the parent of alias, validating
// that the resulting chain is acyclic and game-compatible.
func (c *Config) SetParent(alias, parent string) error {
	ctx, ok := c.Contexts[alias]
	if !ok {
		return fmt.Errorf("context %q not found", alias)
	}
	if parent != "" {
		if _, ok := c.Contexts[parent]; !ok {
			return fmt.Errorf("parent context %q not found", parent)
		}
		if parent == alias {
			return errors.New("a context cannot be its own parent")
		}
	}
	old := ctx.Parent
	ctx.Parent = parent
	c.Contexts[alias] = ctx
	if _, err := c.ResolveChain(alias); err != nil {
		ctx.Parent = old
		c.Contexts[alias] = ctx
		return err
	}
	return nil
}

// Use marks alias as the persisted current context.
func (c *Config) Use(alias string) error {
	if _, exists := c.Contexts[alias]; !exists {
		return fmt.Errorf("context %q not found", alias)
	}
	c.Current = alias
	return nil
}

// Active resolves the context that should be applied to the current
// process. The KBOT_CONTEXT environment variable wins over the
// persisted Current field. The returned bool reports whether any
// context applies; alias is the resolved name, source identifies
// where the choice came from ("env" or "config").
func (c *Config) Active() (alias string, ctx Context, source string, ok bool) {
	if env := strings.TrimSpace(os.Getenv(EnvVar)); env != "" {
		if got, exists := c.Contexts[env]; exists {
			return env, got, "env", true
		}
		// Env var names an unknown context — surface this by returning
		// false so callers can decide whether to error out.
		return env, Context{}, "env", false
	}
	if c.Current != "" {
		if got, exists := c.Contexts[c.Current]; exists {
			return c.Current, got, "config", true
		}
	}
	return "", Context{}, "", false
}

// Path returns the on-disk path the config was loaded from.
func (c *Config) Path() string { return c.path }

// RememberWorkspace records (or refreshes) a workspace in the recents index,
// moving it to the front. Entries are de-duplicated by absolute path.
func (c *Config) RememberWorkspace(ref WorkspaceRef) error {
	abs, err := filepath.Abs(ref.Path)
	if err != nil {
		return fmt.Errorf("resolve workspace path: %w", err)
	}
	ref.Path = abs
	filtered := c.Workspaces[:0:0]
	for _, w := range c.Workspaces {
		if w.Path != abs {
			filtered = append(filtered, w)
		}
	}
	c.Workspaces = append([]WorkspaceRef{ref}, filtered...)
	return nil
}

// ForgetWorkspace removes a workspace from the recents index by path. It is a
// no-op if the path is not present.
func (c *Config) ForgetWorkspace(path string) {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	filtered := c.Workspaces[:0:0]
	for _, w := range c.Workspaces {
		if w.Path != abs {
			filtered = append(filtered, w)
		}
	}
	c.Workspaces = filtered
}

// IsKnownGame reports whether g is one of the accepted Game values.
func IsKnownGame(g string) bool {
	for _, k := range ValidGames {
		if g == k {
			return true
		}
	}
	return false
}

func validateAlias(alias string) error {
	if alias == "" {
		return errors.New("alias is required")
	}
	if strings.ContainsAny(alias, "/\\\t\n ") {
		return fmt.Errorf("alias %q contains whitespace or path separators", alias)
	}
	return nil
}

func validateGame(g string) error {
	if g == "" {
		return errors.New("game is required (totala, takingdoms, or custom)")
	}
	if !IsKnownGame(g) {
		return fmt.Errorf("unknown game %q (expected one of: %s)", g, strings.Join(ValidGames, ", "))
	}
	return nil
}
