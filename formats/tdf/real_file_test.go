package tdf

import (
	"fmt"
	"testing"
)

func TestRealARMFARK(t *testing.T) {
	doc, err := ParseFile("/tmp/fbi-test/units/ARMFARK.FBI")
	if err != nil {
		t.Skipf("Skipping real file test: %v", err)
		return
	}

	unit := doc.Section("UNITINFO")
	if unit == nil {
		t.Fatal("No UNITINFO section")
	}

	// Print info
	fmt.Printf("\n=== ARMFARK FBI File ===\n\n")
	fmt.Printf("Unit Name: %s\n", unit.String("UnitName"))
	fmt.Printf("Side: %s\n", unit.String("Side"))
	fmt.Printf("Description: %s\n", unit.String("Description"))
	fmt.Printf("Build Cost (Metal): %d\n", unit.Int("BuildCostMetal"))
	fmt.Printf("Build Cost (Energy): %d\n", unit.Int("BuildCostEnergy"))
	fmt.Printf("Max Damage: %d\n", unit.Int("MaxDamage"))
	fmt.Printf("Max Velocity: %.1f\n", unit.Float("MaxVelocity"))
	fmt.Printf("Energy Use: %.1f\n", unit.Float("EnergyUse"))
	fmt.Printf("Builder: %v\n", unit.Bool("Builder"))
	fmt.Printf("Can Move: %v\n", unit.Bool("canmove"))
	
	fmt.Printf("\nCategories:\n")
	for _, cat := range unit.List("Category") {
		fmt.Printf("  - %s\n", cat)
	}

	// Verify values
	if name := unit.String("UnitName"); name != "ARMFARK" {
		t.Errorf("Expected UnitName=ARMFARK, got %q", name)
	}

	if cost := unit.Int("BuildCostMetal"); cost != 480 {
		t.Errorf("Expected BuildCostMetal=480, got %d", cost)
	}

	// Test round-trip
	output := doc.String()
	doc2, err := ParseString(output)
	if err != nil {
		t.Fatalf("Round-trip parse failed: %v", err)
	}

	unit2 := doc2.Section("UNITINFO")
	if unit2.String("UnitName") != unit.String("UnitName") {
		t.Error("Round-trip failed: UnitName mismatch")
	}

	fmt.Println("✓ Round-trip successful!")

	// Create a new FBI
	fmt.Println("=== Creating New FBI ===")
	
	newDoc := NewDocument()
	newUnit := newDoc.AddSection("UNITINFO")
	newUnit.SetString("UnitName", "CUSTOMBOT")
	newUnit.SetString("Version", "1.0")
	newUnit.SetString("Side", "ARM")
	newUnit.SetString("Description", "Custom Test Bot")
	newUnit.SetInt("BuildCostMetal", 150)
	newUnit.SetInt("BuildCostEnergy", 800)
	newUnit.SetInt("MaxDamage", 500)
	newUnit.SetFloat("MaxVelocity", 3.0)
	newUnit.SetBool("Builder", false)
	newUnit.SetBool("canmove", true)
	newUnit.SetList("Category", []string{"ARM", "KBOT", "WEAPON"})

	fmt.Println(newDoc.String())

	// Write it
	if err := newDoc.WriteFile("/tmp/CUSTOMBOT.FBI"); err != nil {
		t.Errorf("Failed to write: %v", err)
	} else {
		fmt.Println("✓ Wrote /tmp/CUSTOMBOT.FBI")
	}
}
