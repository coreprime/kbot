package common

// KeysFile is a keys.tdf document — the customizable keyboard table both
// games speak. TA:Kingdoms ships one at its root; Total Annihilation
// hardcoded the equivalent bindings in its executable, but mods may provide
// the file and the studio honours it for either game.
type KeysFile struct {
	// CustomKeys maps key tokens (LOWER_A, UPPER_T, CTRL_B, CTRLSHIFT_Y,
	// plain digits) to command strings ("SelectUnits BALLISTIC",
	// "UnitCommand Attack", "CreateSquad 3"). Keys bound to nothing
	// ("LOWER_B =;") decode as empty strings.
	CustomKeys map[string]string `tdf:"CUSTOMKEYS"`
}
