package mount

import (
	"bytes"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/ai"
	"github.com/coreprime/kbot/internal/aiprofile"
)

func TestWriteAIProfileFollowsTheGame(t *testing.T) {
	units := []ai.Unit{
		{Name: "ARMRAD", Categories: []string{"ARM"}},
		{Name: "CORFORT", Categories: []string{"CORE"}},
	}
	profile := "weight cormakr 0.2\n\nplan easy\nWeight ARM 0.2\nWeight ARMRAD 0.25\nLimit CORFORT O\nLimit ARMRAD -2\nLimit ARM -1\n"
	var buf bytes.Buffer
	writeAIProfile(&buf, aiprofile.Build([]byte(profile), units))
	out := buf.String()
	for _, want := range []string{
		"ignored when a game starts",
		"CORMAKR",
		"category  x0.2",
		"unit      x0.25",
		`disabled   (written "O")`,
		"ARMRAD                   unit      disabled",
		"ARM                      category  unlimited",
		`"O" is not a number`,
		"Easy",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Max: -2") || strings.Contains(out, "-2\n") {
		t.Errorf("a negative limit is shown as a maximum:\n%s", out)
	}
}
