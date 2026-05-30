package ta

// Category is one section of gamedata/category.tdf: a unit-category name mapped
// to a human-readable description. Decode the whole file with
//
//	var cats []ta.Category
//	err := tdf.Unmarshal(data, &cats)
type Category struct {
	Key string `tdf:",name"` // section header, e.g. "Generic Unit"

	Description string `tdf:"description,omitempty"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}
