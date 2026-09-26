package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	mcplib "github.com/mark3labs/mcp-go/mcp"
)

// tdf_parse reads text the way the game does and reports diagnostics.
func TestTDFParseUsesTheGameGrammar(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "corplas.fbi")
	text := "[UNITINFO]\n{\n\tName=Immolator; //c\n\tMaxDamage=842;  /* was 710 */\n\tName=Again;\n}\n[EXIST] {}\n"
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	guard, err := NewPathGuard([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	res, err := makeTDFParseHandler(NewResolver(guard, NewRegistry()))(context.Background(), mcplib.CallToolRequest{
		Params: mcplib.CallToolParams{Name: "tdf_parse", Arguments: map[string]any{"path": p}},
	})
	if err != nil || res == nil || res.IsError {
		t.Fatalf("handler: %v %s", err, textOf(res))
	}
	var out tdfOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Sections) != 2 || out.Sections[1].Name != "EXIST" {
		t.Fatalf("sections = %+v, want UNITINFO and the one-line EXIST", out.Sections)
	}
	fields := map[string]string{}
	for _, f := range out.Sections[0].Fields {
		fields[f.Key] = f.Value
	}
	if fields["MaxDamage"] != "842" {
		t.Errorf("MaxDamage = %q, want 842 with the comment blanked", fields["MaxDamage"])
	}
	if len(out.Diagnostics) == 0 {
		t.Error("no diagnostic for the duplicate Name key")
	}
}
