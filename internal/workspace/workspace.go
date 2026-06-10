// Package workspace models an editable KBot Studio workspace: a writable work
// folder overlaid on top of a kbot context (and that context's parent chain).
//
// A workspace is described by a YAML manifest (workspace.yaml) stored in the
// work folder, which makes it portable and self-describing. The kbot config at
// ~/.kbot keeps a lightweight recents index pointing at workspaces; the
// manifest is the source of truth.
package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// ManifestName is the basename of the workspace manifest within a work folder.
const ManifestName = "workspace.yaml"

// Export format identifiers for "Export Mod".
const (
	ExportHPIv1 = "hpi-v1" // Total Annihilation archives
	ExportHPIv2 = "hpi-v2" // TA: Kingdoms archives
)

// WorkspaceLabel is the VFS layer label used for the writable overlay.
const WorkspaceLabel = "Workspace"

// Mod holds the metadata stamped into an exported mod archive.
type Mod struct {
	Title   string `yaml:"title,omitempty"`
	Author  string `yaml:"author,omitempty"`
	Version string `yaml:"version,omitempty"`
}

// Export configures how the workspace is packaged by "Export Mod".
type Export struct {
	Format string `yaml:"format,omitempty"`
}

// Manifest is the on-disk shape of workspace.yaml.
type Manifest struct {
	Name   string `yaml:"name"`
	Base   string `yaml:"base"`
	Game   string `yaml:"game,omitempty"`
	Mod    Mod    `yaml:"mod,omitempty"`
	Export Export `yaml:"export,omitempty"`

	dir string // work folder, not serialised
}

// DefaultExportFormat returns the natural archive format for a game flavour.
func DefaultExportFormat(game string) string {
	if game == kbotctx.GameTAKingdoms {
		return ExportHPIv2
	}
	return ExportHPIv1
}

// Dir returns the work folder backing the workspace.
func (m *Manifest) Dir() string { return m.dir }

// ManifestPath returns the full path to the workspace's manifest file.
func (m *Manifest) ManifestPath() string { return filepath.Join(m.dir, ManifestName) }

// validate checks the required fields.
func (m *Manifest) validate() error {
	if m.Name == "" {
		return errors.New("workspace name is required")
	}
	if m.Base == "" {
		return errors.New("workspace base context is required")
	}
	return nil
}

// New builds a manifest for a work folder layered on a base context, filling in
// the game flavour and export format from the context when not provided.
func New(dir, name string, base kbotctx.Context, baseAlias string) *Manifest {
	return &Manifest{
		Name:   name,
		Base:   baseAlias,
		Game:   base.Game,
		Export: Export{Format: DefaultExportFormat(base.Game)},
		dir:    dir,
	}
}

// Load reads and validates the manifest from a work folder.
func Load(dir string) (*Manifest, error) {
	data, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return nil, fmt.Errorf("read workspace manifest: %w", err)
	}
	m := &Manifest{}
	if err := yaml.Unmarshal(data, m); err != nil {
		return nil, fmt.Errorf("parse workspace manifest: %w", err)
	}
	m.dir = dir
	if err := m.validate(); err != nil {
		return nil, err
	}
	return m, nil
}

// Save writes the manifest into its work folder, creating the folder if needed.
func (m *Manifest) Save() error {
	if err := m.validate(); err != nil {
		return err
	}
	if m.dir == "" {
		return errors.New("workspace has no work folder")
	}
	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		return fmt.Errorf("create work folder: %w", err)
	}
	data, err := yaml.Marshal(m)
	if err != nil {
		return fmt.Errorf("encode workspace manifest: %w", err)
	}
	if err := os.WriteFile(m.ManifestPath(), data, 0o644); err != nil {
		return fmt.Errorf("write workspace manifest: %w", err)
	}
	return nil
}

// Ref returns the recents-index entry for this workspace.
func (m *Manifest) Ref() kbotctx.WorkspaceRef {
	return kbotctx.WorkspaceRef{Name: m.Name, Path: m.dir, Base: m.Base}
}

// ResolveSources builds the ordered VFS source stack for this workspace: the
// writable work folder on top, then the base context and its parent chain
// (highest priority first). It fails if the base context (or chain) is invalid.
func (m *Manifest) ResolveSources(cfg *kbotctx.Config) ([]filesystem.Source, error) {
	chain, err := cfg.ResolveChain(m.Base)
	if err != nil {
		return nil, err
	}
	sources := make([]filesystem.Source, 0, len(chain)+1)
	sources = append(sources, filesystem.Source{
		Kind:     filesystem.SourceLooseDir,
		Path:     m.dir,
		Writable: true,
		Label:    WorkspaceLabel,
	})
	for _, alias := range chain {
		sources = append(sources, filesystem.Source{
			Kind: filesystem.SourceContextDir,
			Path: cfg.Contexts[alias].Path,
		})
	}
	return sources, nil
}

// ContextSources builds the read-only VFS source stack for a context alias and
// its parent chain (highest priority first), with no writable overlay. Used for
// opening a context for browsing without a workspace.
func ContextSources(cfg *kbotctx.Config, alias string) ([]filesystem.Source, error) {
	chain, err := cfg.ResolveChain(alias)
	if err != nil {
		return nil, err
	}
	srcs := make([]filesystem.Source, 0, len(chain))
	for _, a := range chain {
		srcs = append(srcs, filesystem.Source{
			Kind: filesystem.SourceContextDir,
			Path: cfg.Contexts[a].Path,
		})
	}
	return srcs, nil
}

// OpenVFS resolves the workspace's source stack and opens a writable VFS over it.
func (m *Manifest) OpenVFS(cfg *kbotctx.Config, fsConfig *filesystem.Config) (*filesystem.VirtualFileSystem, error) {
	sources, err := m.ResolveSources(cfg)
	if err != nil {
		return nil, err
	}
	return filesystem.NewLayered(sources, fsConfig)
}
