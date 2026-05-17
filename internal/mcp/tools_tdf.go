package mcp

import (
	"context"
	"fmt"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/tdf"
)

func registerTDFTools(s *server.MCPServer, guard *PathGuard) {
	s.AddTool(
		mcplib.NewTool("tdf_parse",
			mcplib.WithDescription(
				"Parse a TDF/FBI/OTA text data file into a structured JSON tree. "+
					"Section names are returned in their original case; field "+
					"order matches the source.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .tdf/.fbi/.ota file."),
			),
		),
		makeTDFParseHandler(guard),
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
	Sections []tdfSection `json:"sections"`
}

func makeTDFParseHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}

		doc, err := tdf.ParseFile(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("parse tdf: %w", err)), nil
		}

		out := tdfOutput{Path: resolved}
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
