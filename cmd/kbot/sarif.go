package main

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

type sarifLog struct {
	Version string     `json:"version"`
	Schema  string     `json:"$schema"`
	Runs    []sarifRun `json:"runs"`
}

type sarifRun struct {
	Tool    sarifTool     `json:"tool"`
	Results []sarifResult `json:"results"`
}

type sarifTool struct {
	Driver sarifDriver `json:"driver"`
}

type sarifDriver struct {
	Name           string      `json:"name"`
	InformationURI string      `json:"informationUri,omitempty"`
	Rules          []sarifRule `json:"rules,omitempty"`
}

type sarifRule struct {
	ID               string        `json:"id"`
	ShortDescription *sarifMessage `json:"shortDescription,omitempty"`
	FullDescription  *sarifMessage `json:"fullDescription,omitempty"`
}

type sarifResult struct {
	RuleID    string          `json:"ruleId"`
	Level     string          `json:"level"`
	Message   sarifMessage    `json:"message"`
	Locations []sarifLocation `json:"locations,omitempty"`
}

type sarifMessage struct {
	Text string `json:"text,omitempty"`
}

type sarifLocation struct {
	PhysicalLocation sarifPhysicalLocation `json:"physicalLocation"`
}

type sarifPhysicalLocation struct {
	ArtifactLocation sarifArtifactLocation `json:"artifactLocation"`
	Region           *sarifRegion          `json:"region,omitempty"`
}

type sarifArtifactLocation struct {
	URI string `json:"uri"`
}

// sarifRegion locates the diagnostic inside the artifact.  Pointer
// fields keep them out of the JSON when the linter doesn't know a
// line/column (e.g. TNT diagnostics that apply to the whole file).
type sarifRegion struct {
	StartLine   int `json:"startLine,omitempty"`
	StartColumn int `json:"startColumn,omitempty"`
	EndLine     int `json:"endLine,omitempty"`
	EndColumn   int `json:"endColumn,omitempty"`
}

// writeSARIF marshals a SARIF run with the kbot driver and writes it
// to the supplied writer with 2-space indentation.  The driver name
// distinguishes which kbot subcommand produced the run so consumers
// can route results to the right rule catalogue.
func writeSARIF(w io.Writer, driverName string, rules []sarifRule, results []sarifResult) error {
	doc := sarifLog{
		Version: "2.1.0",
		Schema:  "https://json.schemastore.org/sarif-2.1.0.json",
		Runs: []sarifRun{{
			Tool: sarifTool{Driver: sarifDriver{
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

// sarifShortRule is a one-line constructor — every kbot rule has a
// short description, hardly any have a long one.
func sarifShortRule(id, short string) sarifRule {
	return sarifRule{ID: id, ShortDescription: &sarifMessage{Text: short}}
}
