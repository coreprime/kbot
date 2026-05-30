package tdf

import (
	"strings"
	"testing"
)

func TestParseSimpleTDF(t *testing.T) {
	content := `[HEADER]
	{
	campaignside=ARM;
	}

[MISSION0]
	{
	missionfile=example.ufo;
	missionname=Build a vehicle plant;
	}`

	doc, err := ParseString(content)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	// Check sections
	if !doc.HasSection("HEADER") {
		t.Error("Missing HEADER section")
	}
	if !doc.HasSection("MISSION0") {
		t.Error("Missing MISSION0 section")
	}

	// Check fields
	header := doc.Section("HEADER")
	if header == nil {
		t.Fatal("HEADER section is nil")
	}

	if side := header.String("campaignside"); side != "ARM" {
		t.Errorf("Expected campaignside=ARM, got %q", side)
	}

	mission := doc.Section("MISSION0")
	if mission == nil {
		t.Fatal("MISSION0 section is nil")
	}

	if file := mission.String("missionfile"); file != "example.ufo" {
		t.Errorf("Expected missionfile=example.ufo, got %q", file)
	}

	if name := mission.String("missionname"); name != "Build a vehicle plant" {
		t.Errorf("Expected missionname='Build a vehicle plant', got %q", name)
	}
}

func TestParseFBI(t *testing.T) {
	content := `[UNITINFO]
	{
	UnitName=ARMFARK;
	Version=1.2;
	Side=ARM;
	Description=Fast Assist-Repair Kbot;
	FootprintX=2;
	FootprintZ=2;
	BuildCostEnergy=3219;
	BuildCostMetal=480;
	MaxDamage=830;
	MaxWaterDepth=22;
	MaxSlope=14;
	EnergyUse=0.4;
	BuildTime=7931;
	WorkerTime=180;
	BMcode=1;
	Builder=1;
	canmove=1;
	MaxVelocity=2.1;
	Category=ARM KBOT LEVEL2 CONSTR NOWEAPON NOTAIR NOTSUB CTRL_B;
	}`

	doc, err := ParseString(content)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	unit := doc.Section("UNITINFO")
	if unit == nil {
		t.Fatal("UNITINFO section is nil")
	}

	// Test string values
	if name := unit.String("UnitName"); name != "ARMFARK" {
		t.Errorf("Expected UnitName=ARMFARK, got %q", name)
	}

	if side := unit.String("Side"); side != "ARM" {
		t.Errorf("Expected Side=ARM, got %q", side)
	}

	if desc := unit.String("Description"); desc != "Fast Assist-Repair Kbot" {
		t.Errorf("Expected description, got %q", desc)
	}

	// Test integer values
	if cost := unit.Int("BuildCostMetal"); cost != 480 {
		t.Errorf("Expected BuildCostMetal=480, got %d", cost)
	}

	if dmg := unit.Int("MaxDamage"); dmg != 830 {
		t.Errorf("Expected MaxDamage=830, got %d", dmg)
	}

	// Test float values
	if energy := unit.Float("EnergyUse"); energy != 0.4 {
		t.Errorf("Expected EnergyUse=0.4, got %f", energy)
	}

	if vel := unit.Float("MaxVelocity"); vel != 2.1 {
		t.Errorf("Expected MaxVelocity=2.1, got %f", vel)
	}

	// Test boolean values
	if !unit.Bool("Builder") {
		t.Error("Expected Builder=true")
	}

	if !unit.Bool("canmove") {
		t.Error("Expected canmove=true")
	}

	// Test list values
	category := unit.List("Category")
	expected := []string{"ARM", "KBOT", "LEVEL2", "CONSTR", "NOWEAPON", "NOTAIR", "NOTSUB", "CTRL_B"}
	if len(category) != len(expected) {
		t.Errorf("Expected %d categories, got %d", len(expected), len(category))
	}

	for i, cat := range expected {
		if i >= len(category) || category[i] != cat {
			t.Errorf("Expected category[%d]=%s, got %s", i, cat, category[i])
		}
	}
}

func TestCaseInsensitive(t *testing.T) {
	content := `[UnitInfo]
	{
	unitname=TEST;
	BuildCost=100;
	}`

	doc, err := ParseString(content)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	// Section names should be case-insensitive
	tests := []string{"UnitInfo", "UNITINFO", "unitinfo", "UnitINFO"}
	for _, name := range tests {
		if !doc.HasSection(name) {
			t.Errorf("Section %q not found (case-insensitive)", name)
		}

		section := doc.Section(name)
		if section == nil {
			t.Errorf("Section(%q) returned nil", name)
		}
	}

	// Field names should be case-insensitive
	section := doc.Section("unitinfo")
	keyTests := []struct {
		key      string
		expected string
	}{
		{"unitname", "TEST"},
		{"UnitName", "TEST"},
		{"UNITNAME", "TEST"},
		{"buildcost", "100"},
		{"BuildCost", "100"},
		{"BUILDCOST", "100"},
	}

	for _, test := range keyTests {
		value := section.String(test.key)
		if value != test.expected {
			t.Errorf("Key %q: expected %q, got %q", test.key, test.expected, value)
		}
	}
}

func TestWriteTDF(t *testing.T) {
	// Create document
	doc := NewDocument()

	// Add sections
	header := doc.AddSection("HEADER")
	header.SetString("campaignside", "ARM")

	mission := doc.AddSection("MISSION0")
	mission.SetString("missionfile", "example.ufo")
	mission.SetString("missionname", "Build a vehicle plant")

	// Convert to string
	output := doc.String()

	// Parse it back
	doc2, err := ParseString(output)
	if err != nil {
		t.Fatalf("Failed to parse generated TDF: %v", err)
	}

	// Verify sections
	if !doc2.HasSection("HEADER") {
		t.Error("Missing HEADER in output")
	}

	if !doc2.HasSection("MISSION0") {
		t.Error("Missing MISSION0 in output")
	}

	// Verify fields
	header2 := doc2.Section("HEADER")
	if side := header2.String("campaignside"); side != "ARM" {
		t.Errorf("Expected campaignside=ARM, got %q", side)
	}

	mission2 := doc2.Section("MISSION0")
	if file := mission2.String("missionfile"); file != "example.ufo" {
		t.Errorf("Expected missionfile=example.ufo, got %q", file)
	}
}

func TestWriteFBI(t *testing.T) {
	// Create FBI document
	doc := NewDocument()

	unit := doc.AddSection("UNITINFO")
	unit.SetString("UnitName", "TESTUNIT")
	unit.SetString("Version", "1.0")
	unit.SetString("Side", "ARM")
	unit.SetString("Description", "Test Unit")
	unit.SetInt("FootprintX", 2)
	unit.SetInt("FootprintZ", 2)
	unit.SetInt("BuildCostMetal", 100)
	unit.SetInt("BuildCostEnergy", 500)
	unit.SetFloat("MaxVelocity", 2.5)
	unit.SetFloat("EnergyUse", 0.5)
	unit.SetBool("Builder", true)
	unit.SetBool("canmove", true)
	unit.SetList("Category", []string{"ARM", "KBOT", "NOWEAPON"})

	// Convert to string
	output := doc.String()

	// Parse it back
	doc2, err := ParseString(output)
	if err != nil {
		t.Fatalf("Failed to parse generated FBI: %v", err)
	}

	unit2 := doc2.Section("UNITINFO")
	if unit2 == nil {
		t.Fatal("UNITINFO section is nil")
	}

	// Verify all fields
	if name := unit2.String("UnitName"); name != "TESTUNIT" {
		t.Errorf("UnitName: expected TESTUNIT, got %q", name)
	}

	if cost := unit2.Int("BuildCostMetal"); cost != 100 {
		t.Errorf("BuildCostMetal: expected 100, got %d", cost)
	}

	if vel := unit2.Float("MaxVelocity"); vel != 2.5 {
		t.Errorf("MaxVelocity: expected 2.5, got %f", vel)
	}

	if !unit2.Bool("Builder") {
		t.Error("Builder: expected true")
	}

	cats := unit2.List("Category")
	expectedCats := []string{"ARM", "KBOT", "NOWEAPON"}
	if len(cats) != len(expectedCats) {
		t.Errorf("Category: expected %d items, got %d", len(expectedCats), len(cats))
	}
}

func TestRealFBIFile(t *testing.T) {
	// Use the actual ARMFARK.FBI content we extracted
	content := `[UNITINFO]
	{
	UnitName=ARMFARK;
	Version=1.2;
	Side=ARM;
	Objectname=ARMFARK;
	Designation=ARM-MED;
	Name=FARK;
	Description=Fast Assist-Repair Kbot;
	FootprintX=2;
	FootprintZ=2;
	BuildCostEnergy=3219;
	BuildCostMetal=480;
	MaxDamage=830;
	MaxWaterDepth=22;
	MaxSlope=14;
	EnergyUse=0.4;
	BuildTime=7931;
	WorkerTime=180;
	BMcode=1;
	Builder=1;
	ThreeD=1;
	ZBuffer=1;
	NoAutoFire=0;
	SightDistance=290;
	RadarDistance=0;
	SoundCategory=ARM_KBOT;
	EnergyStorage=0;
	MetalStorage=0;
	ExplodeAs=BIG_UNITEX;
	SelfDestructAs=BIG_UNIT;
	Category=ARM KBOT LEVEL2 CONSTR NOWEAPON NOTAIR NOTSUB CTRL_B;
	TEDClass=KBOT;
	Copyright=Copyright 1997 Humongous Entertainment. All rights reserved.;
	Corpse=armfark_dead;
	canmove=1;
	canpatrol=1;
	canstop=1;
	canguard=1;
	MaxVelocity=2.1;
	BrakeRate=0.6;
	Acceleration=0.18;
	TurnRate=1010;
	SteeringMode=1;
	ShootMe=1;
	Builddistance=60;
	CanReclamate=1;
	EnergyMake=17;
	MetalMake=0.5;
	DefaultMissionType=Standby;
	maneuverleashlength=640;
	MovementClass=TANKSH2;
	Upright=1;
	downloadable=1;
	}`

	doc, err := ParseString(content)
	if err != nil {
		t.Fatalf("Failed to parse real FBI: %v", err)
	}

	unit := doc.Section("UNITINFO")
	if unit == nil {
		t.Fatal("UNITINFO section is nil")
	}

	// Verify critical fields
	tests := []struct {
		key      string
		expected string
	}{
		{"UnitName", "ARMFARK"},
		{"Version", "1.2"},
		{"Side", "ARM"},
		{"Name", "FARK"},
		{"Description", "Fast Assist-Repair Kbot"},
		{"SoundCategory", "ARM_KBOT"},
		{"Copyright", "Copyright 1997 Humongous Entertainment. All rights reserved."},
		{"DefaultMissionType", "Standby"},
	}

	for _, test := range tests {
		value := unit.String(test.key)
		if value != test.expected {
			t.Errorf("%s: expected %q, got %q", test.key, test.expected, value)
		}
	}

	// Verify numeric fields
	if cost := unit.Int("BuildCostMetal"); cost != 480 {
		t.Errorf("BuildCostMetal: expected 480, got %d", cost)
	}

	if energy := unit.Int("BuildCostEnergy"); energy != 3219 {
		t.Errorf("BuildCostEnergy: expected 3219, got %d", energy)
	}

	// Verify floats
	if vel := unit.Float("MaxVelocity"); vel != 2.1 {
		t.Errorf("MaxVelocity: expected 2.1, got %f", vel)
	}

	// Verify category list
	categories := unit.List("Category")
	if len(categories) != 8 {
		t.Errorf("Expected 8 categories, got %d", len(categories))
	}
}

func TestRealTDFFile(t *testing.T) {
	// Use actual TDF content
	content := `[GreenVent01]
	{
	world=greenworld;
	description=Thermal Vent;
	category=steamvents;
	animating=1;
	footprintx=1;
	footprintz=1;
	height=0;
	filename=greenvents;
	seqname=vent01;
	geothermal=1;
	hitdensity=0;
	indestructible=1;
	}

[GreenVent02]
	{
	world=greenworld;
	description=Thermal Vent;
	category=steamvents;
	animating=1;
	footprintx=1;
	footprintz=1;
	height=0;
	filename=greenvents;
	seqname=vent02;
	geothermal=1;
	hitdensity=0;
	indestructible=1;
	}`

	doc, err := ParseString(content)
	if err != nil {
		t.Fatalf("Failed to parse real TDF: %v", err)
	}

	// Check both sections exist
	if !doc.HasSection("GreenVent01") {
		t.Error("Missing GreenVent01 section")
	}

	if !doc.HasSection("GreenVent02") {
		t.Error("Missing GreenVent02 section")
	}

	// Verify first vent
	vent1 := doc.Section("GreenVent01")
	if vent1 == nil {
		t.Fatal("GreenVent01 section is nil")
	}

	if world := vent1.String("world"); world != "greenworld" {
		t.Errorf("world: expected greenworld, got %q", world)
	}

	if desc := vent1.String("description"); desc != "Thermal Vent" {
		t.Errorf("description: expected 'Thermal Vent', got %q", desc)
	}

	if !vent1.Bool("animating") {
		t.Error("animating: expected true")
	}

	if !vent1.Bool("geothermal") {
		t.Error("geothermal: expected true")
	}

	if !vent1.Bool("indestructible") {
		t.Error("indestructible: expected true")
	}

	if fp := vent1.Int("footprintx"); fp != 1 {
		t.Errorf("footprintx: expected 1, got %d", fp)
	}
}

func TestEmptyValues(t *testing.T) {
	doc := NewDocument()
	section := doc.AddSection("TEST")

	// Test missing values return defaults
	if s := section.String("missing"); s != "" {
		t.Errorf("Expected empty string, got %q", s)
	}

	if i := section.Int("missing"); i != 0 {
		t.Errorf("Expected 0, got %d", i)
	}

	if f := section.Float("missing"); f != 0.0 {
		t.Errorf("Expected 0.0, got %f", f)
	}

	if b := section.Bool("missing"); b != false {
		t.Errorf("Expected false, got %v", b)
	}

	if l := section.List("missing"); l != nil {
		t.Errorf("Expected nil, got %v", l)
	}
}

func TestComments(t *testing.T) {
	content := `// This is a comment
[SECTION]
	{
	// Another comment
	key=value;
	// More comments
	}
// Final comment`

	doc, err := ParseString(content)
	if err != nil {
		t.Fatalf("Failed to parse with comments: %v", err)
	}

	if !doc.HasSection("SECTION") {
		t.Error("Missing SECTION")
	}

	section := doc.Section("SECTION")
	if value := section.String("key"); value != "value" {
		t.Errorf("Expected key=value, got %q", value)
	}
}

// Benchmark parsing
func BenchmarkParseFBI(b *testing.B) {
	content := `[UNITINFO]
	{
	UnitName=ARMFARK;
	Version=1.2;
	Side=ARM;
	Description=Fast Assist-Repair Kbot;
	BuildCostMetal=480;
	BuildCostEnergy=3219;
	MaxVelocity=2.1;
	Category=ARM KBOT LEVEL2;
	}`

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = ParseString(content)
	}
}

// Benchmark writing
func BenchmarkWriteFBI(b *testing.B) {
	doc := NewDocument()
	unit := doc.AddSection("UNITINFO")
	unit.SetString("UnitName", "TESTUNIT")
	unit.SetInt("BuildCostMetal", 100)
	unit.SetFloat("MaxVelocity", 2.5)
	unit.SetList("Category", []string{"ARM", "KBOT"})

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var sb strings.Builder
		_ = doc.Write(&sb)
	}
}
