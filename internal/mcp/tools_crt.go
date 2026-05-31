package mcp

import (
	"context"
	"fmt"
	"os"
	"sort"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/crt"
)

func registerCRTTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("crt_describe",
			mcplib.WithDescription(
				"Summarise a TA: Kingdoms .crt scenario file: the pre-placed unit "+
					"table (with positions, owning player and facing), per-player rule "+
					"counts and named trigger regions. Multiplayer maps ship an empty "+
					"stub; campaign and special maps populate every section.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .crt file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithBoolean("units",
				mcplib.Description("Include the full per-unit placement list (default false)."),
			),
			withGameData(),
		),
		makeCRTDescribeHandler(r),
	)
}

type crtUnitOutput struct {
	Type    string `json:"type"`
	Name    string `json:"name,omitempty"`
	Player  uint32 `json:"player"`
	X       uint32 `json:"x"`
	Y       uint32 `json:"y"`
	Z       uint32 `json:"z"`
	Angle   uint32 `json:"angle"`
	Health  uint32 `json:"health_percent"`
	Armor   uint32 `json:"armor_percent"`
	Weapon  uint32 `json:"weapon_percent"`
	Veteran uint32 `json:"veteran"`
}

type crtTriggerOutput struct {
	Name   string `json:"name"`
	Left   uint32 `json:"left"`
	Top    uint32 `json:"top"`
	Right  uint32 `json:"right"`
	Bottom uint32 `json:"bottom"`
}

type crtUnitCount struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

type crtDescribeOutput struct {
	Path       string             `json:"path"`
	Source     string             `json:"source,omitempty"`
	FileSize   int64              `json:"file_size"`
	UnitCount  int                `json:"unit_count"`
	UnitTypes  []crtUnitCount     `json:"unit_types,omitempty"`
	Players    int                `json:"players"`
	RuleCount  int                `json:"rule_count"`
	Triggers   []crtTriggerOutput `json:"triggers,omitempty"`
	Placements []crtUnitOutput    `json:"placements,omitempty"`
}

func makeCRTDescribeHandler(r *Resolver) server.ToolHandlerFunc {
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

		data, err := os.ReadFile(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("read crt: %w", err)), nil
		}
		f, err := crt.Load(data)
		if err != nil {
			return errorResult(fmt.Errorf("parse crt: %w", err)), nil
		}

		out := crtDescribeOutput{
			Path:      rf.displayPath(),
			Source:    rf.Source,
			FileSize:  int64(len(data)),
			UnitCount: len(f.Units),
			Players:   len(f.Players),
			RuleCount: f.RuleCount(),
		}
		for ty, c := range f.UnitCounts() {
			out.UnitTypes = append(out.UnitTypes, crtUnitCount{Type: ty, Count: c})
		}
		sort.Slice(out.UnitTypes, func(i, j int) bool {
			if out.UnitTypes[i].Count != out.UnitTypes[j].Count {
				return out.UnitTypes[i].Count > out.UnitTypes[j].Count
			}
			return out.UnitTypes[i].Type < out.UnitTypes[j].Type
		})
		for _, t := range f.Triggers {
			out.Triggers = append(out.Triggers, crtTriggerOutput{
				Name: t.Name, Left: t.Left, Top: t.Top, Right: t.Right, Bottom: t.Bottom,
			})
		}
		if req.GetBool("units", false) {
			for _, u := range f.Units {
				out.Placements = append(out.Placements, crtUnitOutput{
					Type: u.Type, Name: u.Name, Player: u.Player,
					X: u.X, Y: u.Y, Z: u.Z, Angle: u.Angle,
					Health: u.HealthPercent, Armor: u.ArmorPercent,
					Weapon: u.WeaponPercent, Veteran: u.Veteran,
				})
			}
		}
		return jsonResult(out)
	}
}
