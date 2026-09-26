package assetrender

import (
	"encoding/json"
	"testing"
)

type tdfTestSection struct {
	name   string
	fields map[string]string
}

func describedSections(t *testing.T, vpath, text string) ([]tdfTestSection, []string) {
	t.Helper()
	out, ok := newTestRenderer(t).Describe(vpath, []byte(text))
	if !ok {
		t.Fatalf("%s not described", vpath)
	}
	raw, err := jsonRoundTrip(out["sections"])
	if err != nil {
		t.Fatal(err)
	}
	var secs []struct {
		Name   string `json:"name"`
		Fields []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"fields"`
	}
	if err := raw(&secs); err != nil {
		t.Fatal(err)
	}
	var got []tdfTestSection
	for _, s := range secs {
		ts := tdfTestSection{name: s.Name, fields: map[string]string{}}
		for _, f := range s.Fields {
			ts.fields[f.Key] = f.Value
		}
		got = append(got, ts)
	}
	diags, _ := out["tdfDiagnostics"].([]string)
	return got, diags
}

// The asset explorer's TDF view reads text the way the game does: comments
// are blanked, a value runs to the next ';' (across a line end) and a
// one-line `[NAME] {}` section is a section.
func TestDescribeTDFUsesTheGameGrammar(t *testing.T) {
	secs, _ := describedSections(t, "units/corplas.fbi",
		"[UNITINFO]\n{\n\tName=Immolator; //c\n\tBuildCostMetal=321;  //C  llt=268\n"+
			"\tDescription=Plasma /* old */ Tower;\n\tMaxDamage=\n842;\n}\n")
	if len(secs) != 1 {
		t.Fatalf("sections = %+v", secs)
	}
	f := secs[0].fields
	if f["Name"] != "Immolator" || f["BuildCostMetal"] != "321" || f["MaxDamage"] != "842" {
		t.Errorf("fields = %v, want comment-free values and MaxDamage read across the line end", f)
	}

	secs, _ = describedSections(t, "maps/multiplay.tdf",
		"// Multiplayer maps resource file\n\n[EXIST]\t{}\n[ARMAAP]\n\t{\n\t}\n")
	if len(secs) != 2 || secs[0].name != "EXIST" {
		t.Errorf("one-line sections: got %+v, want [EXIST] and [ARMAAP]", secs)
	}
}

func TestDescribeTDFReportsDiagnostics(t *testing.T) {
	_, diags := describedSections(t, "gamedata/test.tdf", "[A]\n{\n\tx=1;\n\tx=2;\n}\n")
	if len(diags) == 0 {
		t.Error("no diagnostic for the duplicate key")
	}
}

// jsonRoundTrip marshals v and returns a decoder for the result, so a test
// can read the describe output as the browser receives it.
func jsonRoundTrip(v any) (func(any) error, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return func(dst any) error { return json.Unmarshal(b, dst) }, nil
}
