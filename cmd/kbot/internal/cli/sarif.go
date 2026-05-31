package cli

import (
	"encoding/json"
	"io"
)

// Minimal SARIF 2.1.0 JSON shapes used by kbot's lint commands when
// the --ci flag is set.  We only emit the subset GitHub Code
// Scanning, GitLab and Harness all consume — enough for issues to
// appear in the standard "code scanning alerts" panels.  The full
// schema is at
// https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/sarif-v2.1.0-cs01.html

type SARIFLog struct {
	Version string     `json:"version"`
	Schema  string     `json:"$schema"`
	Runs    []SARIFRun `json:"runs"`
}

type SARIFRun struct {
	Tool    SARIFTool     `json:"tool"`
	Results []SARIFResult `json:"results"`
}

type SARIFTool struct {
	Driver SARIFDriver `json:"driver"`
}

type SARIFDriver struct {
	Name           string      `json:"name"`
	InformationURI string      `json:"informationUri,omitempty"`
	Rules          []SARIFRule `json:"rules,omitempty"`
}

type SARIFRule struct {
	ID               string        `json:"id"`
	ShortDescription *SARIFMessage `json:"shortDescription,omitempty"`
	FullDescription  *SARIFMessage `json:"fullDescription,omitempty"`
}

type SARIFResult struct {
	RuleID    string          `json:"ruleId"`
	Level     string          `json:"level"`
	Message   SARIFMessage    `json:"message"`
	Locations []SARIFLocation `json:"locations,omitempty"`
}

type SARIFMessage struct {
	Text string `json:"text,omitempty"`
}

type SARIFLocation struct {
	PhysicalLocation SARIFPhysicalLocation `json:"physicalLocation"`
}

type SARIFPhysicalLocation struct {
	ArtifactLocation SARIFArtifactLocation `json:"artifactLocation"`
	Region           *SARIFRegion          `json:"region,omitempty"`
}

type SARIFArtifactLocation struct {
	URI string `json:"uri"`
}

// SARIFRegion locates the diagnostic inside the artifact.  Pointer
// fields keep them out of the JSON when the linter doesn't know a
// line/column (e.g. TNT diagnostics that apply to the whole file).
type SARIFRegion struct {
	StartLine   int `json:"startLine,omitempty"`
	StartColumn int `json:"startColumn,omitempty"`
	EndLine     int `json:"endLine,omitempty"`
	EndColumn   int `json:"endColumn,omitempty"`
}

// WriteSARIF marshals a SARIF run with the kbot driver and writes it
// to the supplied writer with 2-space indentation.  The driver name
// distinguishes which kbot subcommand produced the run so consumers
// can route results to the right rule catalogue.
func WriteSARIF(w io.Writer, driverName string, rules []SARIFRule, results []SARIFResult) error {
	doc := SARIFLog{
		Version: "2.1.0",
		Schema:  "https://json.schemastore.org/sarif-2.1.0.json",
		Runs: []SARIFRun{{
			Tool: SARIFTool{Driver: SARIFDriver{
				Name:           driverName,
				InformationURI: "https://github.com/coreprime/kbot",
				Rules:          rules,
			}},
			Results: results,
		}},
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(doc)
}

// SARIFShortRule is a one-line constructor — every kbot rule has a
// short description, hardly any have a long one.
func SARIFShortRule(id, short string) SARIFRule {
	return SARIFRule{ID: id, ShortDescription: &SARIFMessage{Text: short}}
}
