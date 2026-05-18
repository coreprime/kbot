package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/kbotctx"
)

// withTempHome isolates the kbot config under a temp $HOME.
func withTempHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv(kbotctx.EnvVar, "")
}

func runHere(t *testing.T, cwd string, stdin string) (*cobra.Command, *bytes.Buffer, *bytes.Buffer, error) {
	t.Helper()
	cmd := newCtxHereCommand()
	stderr := &bytes.Buffer{}
	stdout := &bytes.Buffer{}
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	cmd.SetIn(bytes.NewBufferString(stdin))
	err := runCtxHere(cmd, func() (string, error) { return cwd, nil })
	return cmd, stdout, stderr, err
}

func TestCtxHere_SwitchesWhenCWDAlreadyRegistered(t *testing.T) {
	withTempHome(t)

	dir := t.TempDir()
	cfg, err := kbotctx.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	_ = cfg.Add("alpha", kbotctx.Context{Path: t.TempDir(), Game: kbotctx.GameCustom}, false)
	_ = cfg.Add("here", kbotctx.Context{Path: dir, Game: kbotctx.GameCustom}, false)
	_ = cfg.Use("alpha")
	if err := cfg.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}

	_, _, stderr, err := runHere(t, dir, "")
	if err != nil {
		t.Fatalf("runCtxHere: %v", err)
	}
	if !strings.Contains(stderr.String(), `Switched current context to "here"`) {
		t.Fatalf("unexpected stderr:\n%s", stderr.String())
	}

	reloaded, _ := kbotctx.Load()
	if reloaded.Current != "here" {
		t.Fatalf("expected current=%q, got %q", "here", reloaded.Current)
	}
}

func TestCtxHere_NoopWhenAlreadyCurrent(t *testing.T) {
	withTempHome(t)
	dir := t.TempDir()
	cfg, _ := kbotctx.Load()
	_ = cfg.Add("here", kbotctx.Context{Path: dir, Game: kbotctx.GameCustom}, false)
	_ = cfg.Use("here")
	_ = cfg.Save()

	_, _, stderr, err := runHere(t, dir, "")
	if err != nil {
		t.Fatalf("runCtxHere: %v", err)
	}
	if !strings.Contains(stderr.String(), `Already on context "here"`) {
		t.Fatalf("unexpected stderr:\n%s", stderr.String())
	}
}

func TestCtxHere_InteractivePromptRegistersNewContext(t *testing.T) {
	withTempHome(t)
	dir := filepath.Join(t.TempDir(), "totala")
	if err := mkAll(t, dir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// Scripted input:
	//   alias=test-totala
	//   game=1 (totala)
	//   version=3.1c
	//   confirm=y
	input := strings.Join([]string{"test-totala", "1", "3.1c", "y", ""}, "\n")

	_, _, stderr, err := runHere(t, dir, input)
	if err != nil {
		t.Fatalf("runCtxHere: %v\nstderr=%s", err, stderr.String())
	}

	reloaded, _ := kbotctx.Load()
	got, ok := reloaded.Contexts["test-totala"]
	if !ok {
		t.Fatalf("expected context %q to be registered: %+v", "test-totala", reloaded.Contexts)
	}
	if got.Game != kbotctx.GameTotalA {
		t.Fatalf("game=%q, want %q", got.Game, kbotctx.GameTotalA)
	}
	if got.Version != "3.1c" {
		t.Fatalf("version=%q, want %q", got.Version, "3.1c")
	}
	if got.Path != dir {
		t.Fatalf("path=%q, want %q", got.Path, dir)
	}
	if reloaded.Current != "test-totala" {
		t.Fatalf("expected current=%q, got %q", "test-totala", reloaded.Current)
	}

	out := stderr.String()
	for _, want := range []string{"Register kbot context", "Alias", "Game type", "Version", "Confirm", "Added context"} {
		if !strings.Contains(out, want) {
			t.Fatalf("expected stderr to mention %q, got:\n%s", want, out)
		}
	}
}

func TestCtxHere_AcceptsDefaultsOnEmptyInput(t *testing.T) {
	withTempHome(t)
	dir := filepath.Join(t.TempDir(), "totala")
	if err := mkAll(t, dir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// All blank lines: suggested alias, default game (1=totala), empty
	// version, default confirm (Y).
	input := strings.Join([]string{"", "", "", "", ""}, "\n")

	_, _, _, err := runHere(t, dir, input)
	if err != nil {
		t.Fatalf("runCtxHere: %v", err)
	}

	reloaded, _ := kbotctx.Load()
	got, ok := reloaded.Contexts["totala"]
	if !ok {
		t.Fatalf("expected suggested alias %q, got %+v", "totala", reloaded.Contexts)
	}
	if got.Game != kbotctx.GameTotalA {
		t.Fatalf("game=%q, want %q", got.Game, kbotctx.GameTotalA)
	}
	if got.Version != "" {
		t.Fatalf("version=%q, want empty", got.Version)
	}
}

func TestCtxHere_RejectsDuplicateAliasAndReprompts(t *testing.T) {
	withTempHome(t)
	cfg, _ := kbotctx.Load()
	_ = cfg.Add("taken", kbotctx.Context{Path: t.TempDir(), Game: kbotctx.GameCustom}, false)
	_ = cfg.Save()

	dir := filepath.Join(t.TempDir(), "totala")
	if err := mkAll(t, dir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	// First attempt with duplicate alias should be rejected; second
	// attempt with a fresh alias succeeds.
	input := strings.Join([]string{"taken", "fresh", "1", "", "y", ""}, "\n")
	_, _, stderr, err := runHere(t, dir, input)
	if err != nil {
		t.Fatalf("runCtxHere: %v", err)
	}
	if !strings.Contains(stderr.String(), "already exists") {
		t.Fatalf("expected duplicate-alias error in stderr, got:\n%s", stderr.String())
	}
	reloaded, _ := kbotctx.Load()
	if _, ok := reloaded.Contexts["fresh"]; !ok {
		t.Fatalf("expected fresh alias to be saved, got %+v", reloaded.Contexts)
	}
}

func TestCtxHere_CancelOnConfirmNo(t *testing.T) {
	withTempHome(t)
	dir := filepath.Join(t.TempDir(), "totala")
	if err := mkAll(t, dir); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	input := strings.Join([]string{"cancel-me", "1", "", "n", ""}, "\n")
	_, _, _, err := runHere(t, dir, input)
	if err == nil || !strings.Contains(err.Error(), "cancelled") {
		t.Fatalf("expected cancellation error, got %v", err)
	}
	reloaded, _ := kbotctx.Load()
	if _, ok := reloaded.Contexts["cancel-me"]; ok {
		t.Fatalf("context should not have been saved on cancel")
	}
}

func TestCtxHere_SuggestAlias_UniqueAcrossDuplicates(t *testing.T) {
	cfg := &kbotctx.Config{Contexts: map[string]kbotctx.Context{
		"totala":   {},
		"totala-2": {},
	}}
	if got := suggestAlias("/games/totala", cfg); got != "totala-3" {
		t.Fatalf("suggestAlias=%q, want %q", got, "totala-3")
	}
}

func TestCtxHere_TruncateLeft(t *testing.T) {
	if got := truncateLeft("abc", 10); got != "abc" {
		t.Fatalf("got %q", got)
	}
	// max counts the ellipsis: 1 ellipsis + (max-1) trailing chars.
	if got := truncateLeft("abcdefghij", 5); got != "…ghij" {
		t.Fatalf("got %q", got)
	}
}

func mkAll(t *testing.T, dir string) error {
	t.Helper()
	return os.MkdirAll(dir, 0o755)
}
