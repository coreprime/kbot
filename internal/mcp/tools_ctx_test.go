package mcp

import (
	"context"
	"encoding/json"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"
)

func newResolverWithRegistry(t *testing.T, r *Registry) *Resolver {
	t.Helper()
	guard, err := NewPathGuard(nil)
	if err != nil {
		t.Fatalf("NewPathGuard: %v", err)
	}
	return NewResolver(guard, r)
}

func TestCtxListHandler(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	rootA := t.TempDir()
	rootB := t.TempDir()
	if _, err := r.AddNamed("ta-gog", rootA,
		WithGame("totala"), WithVersion("3.1c"), WithSource("context"),
	); err != nil {
		t.Fatalf("AddNamed ta-gog: %v", err)
	}
	if _, err := r.AddNamed("kingdoms", rootB,
		WithGame("takingdoms"), WithSource("context"),
	); err != nil {
		t.Fatalf("AddNamed kingdoms: %v", err)
	}

	res, err := makeCtxListHandler(newResolverWithRegistry(t, r))(context.Background(), mcplib.CallToolRequest{})
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("unexpected error result: %#v", res)
	}

	var out ctxListOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, textOf(res))
	}
	if out.Count != 2 {
		t.Fatalf("Count = %d, want 2", out.Count)
	}
	if out.Current != "ta-gog" {
		t.Fatalf("Current = %q, want %q", out.Current, "ta-gog")
	}
	if len(out.Contexts) != 2 {
		t.Fatalf("contexts len = %d, want 2", len(out.Contexts))
	}
	if !out.Contexts[0].Current {
		t.Fatalf("first context should be current")
	}
	if out.Contexts[0].Game != "totala" || out.Contexts[0].Version != "3.1c" {
		t.Fatalf("metadata not surfaced: %+v", out.Contexts[0])
	}
	if out.Contexts[0].Source != "context" {
		t.Fatalf("source = %q, want %q", out.Contexts[0].Source, "context")
	}
}

func TestCtxListHandler_Empty(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()
	res, err := makeCtxListHandler(newResolverWithRegistry(t, r))(context.Background(), mcplib.CallToolRequest{})
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	var out ctxListOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Count != 0 || out.Current != "" || len(out.Contexts) != 0 {
		t.Fatalf("expected empty output, got %+v", out)
	}
}

func TestCtxCurrentHandler(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	root := t.TempDir()
	if _, err := r.AddNamed("ta-gog", root,
		WithGame("totala"), WithVersion("3.1c"), WithSource("context"),
	); err != nil {
		t.Fatalf("AddNamed: %v", err)
	}

	res, err := makeCtxCurrentHandler(newResolverWithRegistry(t, r))(context.Background(), mcplib.CallToolRequest{})
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	var out ctxCurrentOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, textOf(res))
	}
	if out.None {
		t.Fatalf("expected current context, got none")
	}
	if out.Alias != "ta-gog" || out.Game != "totala" || out.Version != "3.1c" {
		t.Fatalf("unexpected current: %+v", out)
	}
}

func TestCtxCurrentHandler_None(t *testing.T) {
	r := NewRegistry()
	defer func() { _ = r.Close() }()

	res, err := makeCtxCurrentHandler(newResolverWithRegistry(t, r))(context.Background(), mcplib.CallToolRequest{})
	if err != nil {
		t.Fatalf("handler error: %v", err)
	}
	var out ctxCurrentOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !out.None {
		t.Fatalf("expected None=true, got %+v", out)
	}
}
