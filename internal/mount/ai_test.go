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

// A value written as a different spelling of the same number gets no note;
// a word the game reads as another number does, and so does a category that
// no unit has.
func TestWriteAIProfileNotesOnlyValuesReadDifferently(t *testing.T) {
	units := []ai.Unit{
		{Name: "ARMMAKR", Categories: []string{"ARM"}},
		{Name: "CORFORT", Categories: []string{"CORE"}},
	}
	profile := "plan easy\nWeight ARMMAKR .1\nWeight CORE 0.20\nLimit CORFORT O\nLimit ARM DECOM\nLimit ARMFMIN1 0\n"
	var buf bytes.Buffer
	writeAIProfile(&buf, aiprofile.Build([]byte(profile), units))
	out := buf.String()
	for _, want := range []string{
		`disabled   (written "O")`,
		`disabled   (written "DECOM")`,
		"ARMFMIN1                 category  disabled   (matches no unit)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	for _, line := range strings.Split(out, "\n") {
		if (strings.Contains(line, "ARMMAKR") || strings.Contains(line, "CORE ")) && strings.Contains(line, "written") {
			t.Errorf("a plain number has a note: %q", line)
		}
		if (strings.Contains(line, "CORFORT") || strings.Contains(line, "ARM ")) && strings.Contains(line, "matches no unit") {
			t.Errorf("a target that matches units is flagged: %q", line)
		}
	}
	if !strings.Contains(out, "ARMMAKR                  unit      x0.1\n") {
		t.Errorf("Weight ARMMAKR .1 is not shown as x0.1 without a note:\n%s", out)
	}
}
