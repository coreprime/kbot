package tdf_test

import (
	"fmt"
	"log"

	"github.com/coreprime/kbot/formats/tdf"
)

func ExampleParse() {
	content := `[UNITINFO]
	{
	UnitName=ARMCOM;
	Side=ARM;
	Description=Commander;
	BuildCostMetal=2500;
	MaxVelocity=1.15;
	Builder=1;
	Category=ARM COMMANDER CTRL_C;
	}`

	doc, err := tdf.ParseString(content)
	if err != nil {
		log.Fatal(err)
	}

	unit := doc.Section("UNITINFO")

	fmt.Println("Unit:", unit.String("UnitName"))
	fmt.Println("Side:", unit.String("Side"))
	fmt.Println("Cost:", unit.Int("BuildCostMetal"))
	fmt.Println("Speed:", unit.Float("MaxVelocity"))
	fmt.Println("Builder:", unit.Bool("Builder"))
	fmt.Println("Categories:", unit.List("Category"))

	// Output:
	// Unit: ARMCOM
	// Side: ARM
	// Cost: 2500
	// Speed: 1.15
	// Builder: true
	// Categories: [ARM COMMANDER CTRL_C]
}

func ExampleNewDocument() {
	doc := tdf.NewDocument()

	unit := doc.AddSection("UNITINFO")
	unit.SetString("UnitName", "CUSTOMBOT")
	unit.SetString("Side", "ARM")
	unit.SetInt("BuildCostMetal", 150)
	unit.SetFloat("MaxVelocity", 3.0)
	unit.SetBool("canmove", true)
	unit.SetList("Category", []string{"ARM", "KBOT", "WEAPON"})

	fmt.Print(doc.String())

	// Output:
	// [UNITINFO]
	// 	{
	// 	UnitName=CUSTOMBOT;
	// 	Side=ARM;
	// 	BuildCostMetal=150;
	// 	MaxVelocity=3;
	// 	canmove=1;
	// 	Category=ARM KBOT WEAPON;
	// 	}
}

func ExampleDocument_Section() {
	content := `[MISSION0]
	{
	missionfile=example.ufo;
	missionname=Build a vehicle plant;
	}`

	doc, _ := tdf.ParseString(content)

	mission := doc.Section("MISSION0")
	if mission != nil {
		fmt.Println("File:", mission.String("missionfile"))
		fmt.Println("Name:", mission.String("missionname"))
	}

	// Output:
	// File: example.ufo
	// Name: Build a vehicle plant
}

func ExampleSection_List() {
	content := `[UNITINFO]
	{
	Category=ARM KBOT LEVEL2 CONSTR NOWEAPON;
	}`

	doc, _ := tdf.ParseString(content)
	unit := doc.Section("UNITINFO")

	for _, category := range unit.List("Category") {
		fmt.Println("-", category)
	}

	// Output:
	// - ARM
	// - KBOT
	// - LEVEL2
	// - CONSTR
	// - NOWEAPON
}

func ExampleSection_Bool() {
	content := `[UNITINFO]
	{
	Builder=1;
	canmove=true;
	Upright=yes;
	NoAutoFire=0;
	}`

	doc, _ := tdf.ParseString(content)
	unit := doc.Section("UNITINFO")

	fmt.Println("Builder:", unit.Bool("Builder"))
	fmt.Println("Can Move:", unit.Bool("canmove"))
	fmt.Println("Upright:", unit.Bool("Upright"))
	fmt.Println("No Auto Fire:", unit.Bool("NoAutoFire"))

	// Output:
	// Builder: true
	// Can Move: true
	// Upright: true
	// No Auto Fire: false
}

func ExampleDocument_WriteFile() {
	doc := tdf.NewDocument()

	feature := doc.AddSection("MetalDeposit")
	feature.SetString("world", "greenworld")
	feature.SetString("description", "Metal Patch")
	feature.SetInt("metal", 500)
	feature.SetBool("reclaimable", true)

	// In real code, check error
	_ = doc.WriteFile("/tmp/metal.tdf")

	fmt.Println("File written")

	// Output:
	// File written
}
