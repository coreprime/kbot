package ai

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
)

// Difficulty represents a game difficulty level
type Difficulty int

const (
	Easy Difficulty = iota
	Medium
	Hard
)

func (d Difficulty) String() string {
	switch d {
	case Easy:
		return "Easy"
	case Medium:
		return "Medium"
	case Hard:
		return "Hard"
	default:
		return "Unknown"
	}
}

// UnitWeight represents a unit's weight value
type UnitWeight struct {
	UnitName string
	Weight   float64
}

// UnitLimit represents a unit's build limit
type UnitLimit struct {
	UnitName string
	Maximum  int
}

// DifficultyPlan represents AI configuration for one difficulty level
type DifficultyPlan struct {
	Name    string        // e.g., "easy", "medium", "hard"
	Weights []UnitWeight  // Weight directives
	Limits  []UnitLimit   // Limit directives
}

// AIFile represents a complete AI configuration file
type AIFile struct {
	Plans []DifficultyPlan
}

// IsAIFile checks if the content looks like a TA / TA: Kingdoms AI profile
// file. TA's own AI files always carry per-difficulty `plan <name>` blocks;
// TA: Kingdoms profiles often skip them and list weights/limits directly, so a
// single weight or limit directive is enough to identify the file.
func IsAIFile(content []byte) bool {
	textLower := strings.ToLower(string(content))
	return strings.Contains(textLower, "weight ") || strings.Contains(textLower, "limit ")
}

// defaultPlanName is the synthetic plan used when an AI file has weights and
// limits but no explicit `plan` directive (the TA: Kingdoms convention).
const defaultPlanName = "default"

// Parse parses an AI file from bytes
func Parse(content []byte) (*AIFile, error) {
	scanner := bufio.NewScanner(bytes.NewReader(content))
	
	var plans []DifficultyPlan
	var currentPlan *DifficultyPlan
	
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		
		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		
		// Parse "plan <difficulty>" directive
		if strings.HasPrefix(strings.ToLower(line), "plan ") {
			// Save previous plan if exists
			if currentPlan != nil {
				plans = append(plans, *currentPlan)
			}
			
			// Start new plan
			difficulty := strings.TrimSpace(line[5:])
			currentPlan = &DifficultyPlan{
				Name:    difficulty,
				Weights: []UnitWeight{},
				Limits:  []UnitLimit{},
			}
			continue
		}
		
		if currentPlan == nil {
			// No `plan` directive yet — TA: Kingdoms profiles are typically
			// laid out this way. Open a synthetic plan so the weights/limits
			// that follow have somewhere to land.
			currentPlan = &DifficultyPlan{
				Name:    defaultPlanName,
				Weights: []UnitWeight{},
				Limits:  []UnitLimit{},
			}
		}

		// Parse "Weight <unit> <value>" directive
		if strings.HasPrefix(strings.ToLower(line), "weight ") {
			parts := strings.Fields(line[7:])
			if len(parts) >= 2 {
				unitName := strings.ToUpper(parts[0])
				weightStr := parts[1]
				
				weight, err := strconv.ParseFloat(weightStr, 64)
				if err != nil {
					// Skip invalid weight values
					continue
				}
				
				currentPlan.Weights = append(currentPlan.Weights, UnitWeight{
					UnitName: unitName,
					Weight:   weight,
				})
			}
			continue
		}
		
		// Parse "Limit <unit> <value>" directive
		if strings.HasPrefix(strings.ToLower(line), "limit ") {
			parts := strings.Fields(line[6:])
			if len(parts) >= 2 {
				unitName := strings.ToUpper(parts[0])
				maxStr := parts[1]
				
				maximum, err := strconv.Atoi(maxStr)
				if err != nil {
					// Skip invalid limit values
					continue
				}
				
				currentPlan.Limits = append(currentPlan.Limits, UnitLimit{
					UnitName: unitName,
					Maximum:  maximum,
				})
			}
			continue
		}
	}
	
	// Save last plan
	if currentPlan != nil {
		plans = append(plans, *currentPlan)
	}
	
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	
	return &AIFile{Plans: plans}, nil
}
