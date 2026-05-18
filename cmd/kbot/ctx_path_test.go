package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/kbotctx"
)

func runCtxPath(t *testing.T, args ...string) (string, string, error) {
	t.Helper()
	cmd := newCtxPathCommand()
	out := &bytes.Buffer{}
	errOut := &bytes.Buffer{}
	cmd.SetOut(out)
	cmd.SetErr(errOut)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), errOut.String(), err
}

func TestCtxPath_PrintsActiveContext(t *testing.T) {
	withTempHome(t)
	cfg, _ := kbotctx.Load()
	_ = cfg.Add("ta", kbotctx.Context{Path: "/games/totala", Game: kbotctx.GameTotalA}, false)
	_ = cfg.Use("ta")
	_ = cfg.Save()

	out, _, err := runCtxPath(t)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got := strings.TrimSpace(out); got != "/games/totala" {
		t.Fatalf("got %q, want %q", got, "/games/totala")
	}
}

func TestCtxPath_RespectsEnvOverride(t *testing.T) {
	withTempHome(t)
	cfg, _ := kbotctx.Load()
	_ = cfg.Add("a", kbotctx.Context{Path: "/games/a", Game: kbotctx.GameCustom}, false)
	_ = cfg.Add("b", kbotctx.Context{Path: "/games/b", Game: kbotctx.GameCustom}, false)
	_ = cfg.Use("a")
	_ = cfg.Save()

	t.Setenv(kbotctx.EnvVar, "b")
	out, _, err := runCtxPath(t)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got := strings.TrimSpace(out); got != "/games/b" {
		t.Fatalf("got %q, want %q", got, "/games/b")
	}
}

func TestCtxPath_ExplicitAliasFlag(t *testing.T) {
	withTempHome(t)
	cfg, _ := kbotctx.Load()
	_ = cfg.Add("a", kbotctx.Context{Path: "/games/a", Game: kbotctx.GameCustom}, false)
	_ = cfg.Add("b", kbotctx.Context{Path: "/games/b", Game: kbotctx.GameCustom}, false)
	_ = cfg.Use("a")
	_ = cfg.Save()

	out, _, err := runCtxPath(t, "--alias", "b")
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got := strings.TrimSpace(out); got != "/games/b" {
		t.Fatalf("got %q, want %q", got, "/games/b")
	}
}

func TestCtxPath_ErrorsWhenNoActive(t *testing.T) {
	withTempHome(t)
	_, _, err := runCtxPath(t)
	if err == nil {
		t.Fatalf("expected error when no context is active")
	}
}

func TestCtxPath_ErrorsOnUnknownAlias(t *testing.T) {
	withTempHome(t)
	_, _, err := runCtxPath(t, "--alias", "nope")
	if err == nil {
		t.Fatalf("expected error for unknown alias")
	}
}

func TestCtxPath_ErrorsOnUnknownEnv(t *testing.T) {
	withTempHome(t)
	t.Setenv(kbotctx.EnvVar, "nope")
	_, _, err := runCtxPath(t)
	if err == nil {
		t.Fatalf("expected error for unknown env override")
	}
	if !strings.Contains(err.Error(), kbotctx.EnvVar) {
		t.Fatalf("expected error to mention %s, got %v", kbotctx.EnvVar, err)
	}
}
