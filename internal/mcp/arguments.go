package mcp

import (
	"encoding/json"
	"fmt"

	mcplib "github.com/mark3labs/mcp-go/mcp"
)

// jsonResult serialises v to a single text-content tool result containing
// pretty-printed JSON.  This is the common return shape for kbot's
// structured tools — clients can parse the JSON and the model can read
// it directly.
func jsonResult(v any) (*mcplib.CallToolResult, error) {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode result: %w", err)
	}
	return mcplib.NewToolResultText(string(body)), nil
}

// errorResult wraps err as a CallToolResult with IsError=true rather than
// returning it as a transport error.  MCP distinguishes "the tool ran
// and reported a problem" from "the server crashed"; tool-level failures
// should always use this path.
func errorResult(err error) *mcplib.CallToolResult {
	if err == nil {
		return mcplib.NewToolResultText("ok")
	}
	return mcplib.NewToolResultError(err.Error())
}

// withGameData appends the standard optional game_data parameter every kbot
// tool accepts.  Pass it after the other WithX options when constructing a
// tool so the description shows up consistently across the surface.
func withGameData() mcplib.ToolOption {
	return mcplib.WithString("game_data",
		mcplib.Description("Optional name of a --game-data folder to resolve relative or bare-name paths against. Defaults to the first --game-data folder."),
	)
}
