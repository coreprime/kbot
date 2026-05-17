package ai

import (
	"testing"
)

func TestIsAIFile(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		expected bool
	}{
		{
			name: "valid AI file with plan and weights",
			content: `plan easy
Weight ARMCOM 2.0
Limit ARMCOM 1`,
			expected: true,
		},
		{
			name:     "not an AI file",
			content:  "Just some text",
			expected: false,
		},
		{
			name: "TDF file (not AI)",
			content: `[UNITINFO]
{
	Name=Commander;
}`,
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := IsAIFile([]byte(tt.content))
			if result != tt.expected {
				t.Errorf("IsAIFile() = %v, want %v", result, tt.expected)
			}
		})
	}
}

func TestParse(t *testing.T) {
	content := `// TEST AI FILE

plan easy

Weight ARMCOM 2.0
Weight ARMCK 1.5

Limit ARMCOM 1
Limit ARMCK 5

plan hard

Weight ARMCOM 3.0
Weight ARMCK 2.5
Weight ARMPW 2.0

Limit ARMCOM 1
Limit ARMCK 10
Limit ARMPW 20`

	ai, err := Parse([]byte(content))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	if len(ai.Plans) != 2 {
		t.Fatalf("Expected 2 plans, got %d", len(ai.Plans))
	}

	// Check easy plan
	if ai.Plans[0].Name != "easy" {
		t.Errorf("First plan name = %s, want easy", ai.Plans[0].Name)
	}
	if len(ai.Plans[0].Weights) != 2 {
		t.Errorf("Easy plan weights count = %d, want 2", len(ai.Plans[0].Weights))
	}
	if ai.Plans[0].Weights[0].UnitName != "ARMCOM" {
		t.Errorf("First weight unit = %s, want ARMCOM", ai.Plans[0].Weights[0].UnitName)
	}
	if ai.Plans[0].Weights[0].Weight != 2.0 {
		t.Errorf("ARMCOM weight = %f, want 2.0", ai.Plans[0].Weights[0].Weight)
	}
	if len(ai.Plans[0].Limits) != 2 {
		t.Errorf("Easy plan limits count = %d, want 2", len(ai.Plans[0].Limits))
	}
	if ai.Plans[0].Limits[1].Maximum != 5 {
		t.Errorf("ARMCK limit = %d, want 5", ai.Plans[0].Limits[1].Maximum)
	}

	// Check hard plan
	if ai.Plans[1].Name != "hard" {
		t.Errorf("Second plan name = %s, want hard", ai.Plans[1].Name)
	}
	if len(ai.Plans[1].Weights) != 3 {
		t.Errorf("Hard plan weights count = %d, want 3", len(ai.Plans[1].Weights))
	}
	if len(ai.Plans[1].Limits) != 3 {
		t.Errorf("Hard plan limits count = %d, want 3", len(ai.Plans[1].Limits))
	}
}
