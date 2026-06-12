package common

// DownloadFile is a download/*.tdf add-on menu document — the mechanism
// downloadable units in both games use to graft themselves onto an existing
// builder's construction menu (AFark.ufo ships the canonical example).
type DownloadFile struct {
	// Entries holds every [MENUENTRY], [MENUENTRY0], [MENUENTRY1], ...
	// section in file order (the codec prefix-matches the numbered stems).
	Entries []MenuEntry `tdf:"MENUENTRY"`
}

// MenuEntry is one [MENUENTRYn] section: UnitMenu names the builder whose
// menu gains the unit, UnitName the unit being added, and Menu/Button the
// page and slot it lands on.
type MenuEntry struct {
	UnitMenu string `tdf:"unitmenu,omitempty"`
	Menu     int    `tdf:"menu,omitempty"`
	Button   int    `tdf:"button,omitempty"`
	UnitName string `tdf:"unitname,omitempty"`
}
