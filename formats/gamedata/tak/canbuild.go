package tak

// CanBuildGrant is one canbuild/<builder>/<unit>.tdf file — TA:Kingdoms'
// build-menu mechanism. The file's existence grants the pairing (its path
// names builder and unit); the body only carries menu placement.
type CanBuildGrant struct {
	Menu CanBuildMenu `tdf:"MENU"`
}

// CanBuildMenu is the [Menu] section: Priority orders the builder's menu
// (lower = earlier).
type CanBuildMenu struct {
	Priority int `tdf:"priority,omitempty"`
}
