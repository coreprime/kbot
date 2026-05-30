package ta

// Meteor is one section of gamedata/meteor.tdf: a named meteor-shower weapon
// configuration (the stock file defines a single [Default]). Decode the whole
// file with
//
//	var meteors []ta.Meteor
//	err := tdf.Unmarshal(data, &meteors)
type Meteor struct {
	Key string `tdf:",name"` // section header, e.g. "Default"

	MeteorWeapon   string  `tdf:"meteorweapon,omitempty"`
	MeteorRadius   int     `tdf:"meteorradius,omitempty"`
	MeteorDensity  float64 `tdf:"meteordensity,omitempty"` // Assuming float, due to name/usage
	MeteorDuration int     `tdf:"meteorduration,omitempty"`
	MeteorInterval int     `tdf:"meteorinterval,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}
