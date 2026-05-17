package mcp

import (
	"context"
	"fmt"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/tdf"
)

func registerTDFTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("tdf_parse",
			mcplib.WithDescription(
				"Parse a TDF/FBI/OTA text data file into a structured JSON tree. "+
					"Section names are returned in their original case; field "+
					"order matches the source.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .tdf/.fbi/.ota file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTDFParseHandler(r),
	)
}

// tdfSection is the JSON shape of a parsed TDF section.  Fields are an
// ordered list of {key, value} so order is preserved on the wire.
type tdfSection struct {
	Name     string       `json:"name"`
	Fields   []tdfField   `json:"fields,omitempty"`
	Sections []tdfSection `json:"sections,omitempty"`
}

type tdfField struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type tdfOutput struct {
	Path     string       `json:"path"`
	Source   string       `json:"source,omitempty"`
	Sections []tdfSection `json:"sections"`
}

func makeTDFParseHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		doc, err := tdf.ParseFile(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("parse tdf: %w", err)), nil
		}

		out := tdfOutput{Path: rf.displayPath(), Source: rf.Source}
		for _, s := range doc.Sections() {
			out.Sections = append(out.Sections, convertTDFSection(s))
		}
		return jsonResult(out)
	}
}

func convertTDFSection(s *tdf.Section) tdfSection {
	out := tdfSection{Name: s.Name()}
	for _, f := range s.Fields() {
		out.Fields = append(out.Fields, tdfField{Key: f.Key(), Value: f.Value()})
	}
	for _, child := range s.Sections() {
		out.Sections = append(out.Sections, convertTDFSection(child))
	}
	return out
}
