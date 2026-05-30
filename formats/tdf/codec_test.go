package tdf

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

type damageWeapon struct {
	Name       string            `tdf:",name"`
	ID         int               `tdf:"id"`
	WeaponName string            `tdf:"name"`
	Range      int               `tdf:"range"`
	ReloadTime float64           `tdf:"reloadtime,omitempty"`
	BurstRate  float64           `tdf:"burstrate,omitempty"`
	Turret     int               `tdf:"turret,omitempty"`
	Damage     map[string]int    `tdf:"damage"`
	Extra      map[string]string `tdf:",remaining"`
}

func TestCodecRoundTripWeapon(t *testing.T) {
	src := `[FLAMETHROWER]
	{
	ID=1;
	name=Flame Thrower;
	rendertype=5;
	ballistic=1;
	turret=1;
	range=160;
	reloadtime=1.2;
	burstrate=.04;
	[DAMAGE]
		{
		default=10;
		corpyro=2;
		}
	}`

	var weps []damageWeapon
	if err := Unmarshal([]byte(src), &weps); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(weps) != 1 {
		t.Fatalf("want 1 weapon, got %d", len(weps))
	}
	w := weps[0]
	if w.Name != "FLAMETHROWER" {
		t.Errorf("section name: got %q", w.Name)
	}
	if w.WeaponName != "Flame Thrower" {
		t.Errorf("name: got %q", w.WeaponName)
	}
	if w.ID != 1 || w.Range != 160 {
		t.Errorf("id/range: got %d/%d", w.ID, w.Range)
	}
	if w.BurstRate != 0.04 {
		t.Errorf("shorthand float burstrate: got %v", w.BurstRate)
	}
	if w.ReloadTime != 1.2 {
		t.Errorf("reloadtime: got %v", w.ReloadTime)
	}
	if w.Damage["default"] != 10 || w.Damage["corpyro"] != 2 {
		t.Errorf("damage map: got %v", w.Damage)
	}
	if w.Extra["rendertype"] != "5" || w.Extra["ballistic"] != "1" {
		t.Errorf("remaining map: got %v", w.Extra)
	}

	out, err := Marshal(weps)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if ok, msg := SemanticEqual([]byte(src), out); !ok {
		t.Errorf("semantic round trip failed: %s\n--- out ---\n%s", msg, out)
	}
}

func TestSemanticEqualIgnoresFormatting(t *testing.T) {
	a := `[X] { foo=.6; bar=0; baz=Hello World; }`
	b := `// comment
[X]
	{
	BAZ = Hello World ;   /* trailing */
	FOO = 0.60;
	}`
	if ok, msg := SemanticEqual([]byte(a), []byte(b)); !ok {
		t.Errorf("expected equal: %s", msg)
	}
}

func TestCanonicalizeIdempotent(t *testing.T) {
	src := `[A]{ x=1; [B]{ y=2; } } [A]{ x=3; }`
	once, err := Canonicalize([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	twice, err := Canonicalize(once)
	if err != nil {
		t.Fatal(err)
	}
	if string(once) != string(twice) {
		t.Errorf("not idempotent:\n%s\n---\n%s", once, twice)
	}
}

func TestEmbeddedBasePromotion(t *testing.T) {
	type base struct {
		Key   string            `tdf:",name"`
		Name  string            `tdf:"name,omitempty"`
		Range int               `tdf:"range,omitempty"`
		Extra map[string]string `tdf:",remaining"`
	}
	// leaf embeds base; promoted fields (incl. ,name and ,remaining) must work.
	type leaf struct {
		base
		Foo int `tdf:"foo,omitempty"`
	}
	src := `[WIDGET]{ name=Gun; range=160; foo=7; mystery=42; }`
	var ws []leaf
	if err := Unmarshal([]byte(src), &ws); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(ws) != 1 {
		t.Fatalf("want 1, got %d", len(ws))
	}
	w := ws[0]
	if w.Key != "WIDGET" || w.Name != "Gun" || w.Range != 160 || w.Foo != 7 {
		t.Fatalf("promoted fields: %+v", w)
	}
	if w.Extra["mystery"] != "42" {
		t.Errorf("promoted remaining: %v", w.Extra)
	}
	out, err := Marshal(ws)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if ok, msg := SemanticEqual([]byte(src), out); !ok {
		t.Errorf("embedded round trip failed: %s\n%s", msg, out)
	}
}

func TestRepeatsCountField(t *testing.T) {
	type item struct {
		Name string `tdf:",name"`
		V    int    `tdf:"v,omitempty"`
	}
	type doc struct {
		Items []item            `tdf:"Item,repeats=ITEMCOUNT"`
		Extra map[string]string `tdf:",remaining"`
	}
	src := `ITEMCOUNT=2;
	[Item 0]{ v=10; }
	[Item 1]{ v=20; }`
	var d doc
	if err := Unmarshal([]byte(src), &d); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(d.Items) != 2 || d.Items[0].V != 10 || d.Items[1].V != 20 {
		t.Fatalf("items: %+v", d.Items)
	}
	if _, ok := d.Extra["ITEMCOUNT"]; ok {
		t.Errorf("ITEMCOUNT leaked into remaining: %v", d.Extra)
	}
	out, err := Marshal(d)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(out), "ITEMCOUNT=2;") {
		t.Errorf("expected emitted ITEMCOUNT=2, got:\n%s", out)
	}
	if ok, msg := SemanticEqual([]byte(src), out); !ok {
		t.Errorf("repeats round trip failed: %s\n%s", msg, out)
	}
}

func TestRepeatedSiblingSections(t *testing.T) {
	// Two sections with the same header name must both survive.
	src := `[DUP]{ a=1; } [DUP]{ a=2; }`
	canon, err := Canonicalize([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if ok, msg := SemanticEqual([]byte(src), canon); !ok {
		t.Errorf("dup sections lost: %s\n%s", msg, canon)
	}
}

// rgb is a custom scalar type used to exercise ScalarMarshaler/Unmarshaler.
type rgb struct{ R, G, B int }

func (c rgb) MarshalTDF() (string, error) { return fmt.Sprintf("%d %d %d", c.R, c.G, c.B), nil }

func (c *rgb) UnmarshalTDF(s string) error {
	parts := strings.Fields(s)
	if len(parts) != 3 {
		return fmt.Errorf("rgb %q: want 3 fields", s)
	}
	v := [3]int{}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return err
		}
		v[i] = n
	}
	c.R, c.G, c.B = v[0], v[1], v[2]
	return nil
}

func TestCustomScalarType(t *testing.T) {
	type row struct {
		Name string `tdf:",name"`
		A    *rgb   `tdf:"a,omitempty"`
		B    *rgb   `tdf:"b,omitempty"`
		C    *rgb   `tdf:"c,omitempty"`
	}
	// A present non-zero, B present but zero ("0 0 0"), C absent.
	src := `[ROW]{ a=160 35 0; b=0 0 0; }`
	var rows []row
	if err := Unmarshal([]byte(src), &rows); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	r := rows[0]
	if r.A == nil || *r.A != (rgb{160, 35, 0}) {
		t.Errorf("A = %v, want {160 35 0}", r.A)
	}
	if r.B == nil || *r.B != (rgb{0, 0, 0}) {
		t.Errorf("B = %v, want non-nil {0 0 0}", r.B)
	}
	if r.C != nil {
		t.Errorf("C = %v, want nil (absent)", r.C)
	}
	out, err := Marshal(rows)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(out), "a=160 35 0") {
		t.Errorf("missing a=160 35 0 in:\n%s", out)
	}
	// A non-nil pointer to the zero value must still emit (present, not omitted).
	if !strings.Contains(string(out), "b=0 0 0") {
		t.Errorf("missing b=0 0 0 (zero-but-present) in:\n%s", out)
	}
	if strings.Contains(string(out), "c=") {
		t.Errorf("absent field c should not be emitted:\n%s", out)
	}
	if ok, msg := SemanticEqual([]byte(src), out); !ok {
		t.Errorf("custom scalar round trip: %s\n%s", msg, out)
	}
}

func TestScalarListDelimiter(t *testing.T) {
	type row struct {
		Name  string   `tdf:",name"`
		Nums  []int    `tdf:"nums,delimiter=','"`
		Words []string `tdf:"words,delimiter=' '"`
	}
	// Comma list with irregular spacing around commas must parse cleanly.
	src := `[L]{ nums=2,  3 ,4; words=alpha beta gamma; }`
	var rows []row
	if err := Unmarshal([]byte(src), &rows); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(rows))
	}
	r := rows[0]
	if len(r.Nums) != 3 || r.Nums[0] != 2 || r.Nums[1] != 3 || r.Nums[2] != 4 {
		t.Errorf("Nums = %v, want [2 3 4]", r.Nums)
	}
	if strings.Join(r.Words, "|") != "alpha|beta|gamma" {
		t.Errorf("Words = %v, want [alpha beta gamma]", r.Words)
	}
	out, err := Marshal(rows)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(out), "nums=2,3,4") {
		t.Errorf("expected comma-joined nums in:\n%s", out)
	}
	if !strings.Contains(string(out), "words=alpha beta gamma") {
		t.Errorf("expected space-joined words in:\n%s", out)
	}
}

func TestScalarListDelimiterWithSpace(t *testing.T) {
	// A ", " delimiter reproduces the on-disk spacing exactly, round-tripping.
	type row struct {
		Name string `tdf:",name"`
		Nums []int  `tdf:"nums,delimiter=', '"`
	}
	src := `[L]{ nums=2, 3, 4; }`
	var rows []row
	if err := Unmarshal([]byte(src), &rows); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	out, err := Marshal(rows)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !strings.Contains(string(out), "nums=2, 3, 4") {
		t.Errorf("expected 'nums=2, 3, 4' in:\n%s", out)
	}
	if ok, msg := SemanticEqual([]byte(src), out); !ok {
		t.Errorf("delimiter round trip: %s\n%s", msg, out)
	}
}
