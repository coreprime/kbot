package common

// Section is a generic, recursively-typed TDF section. It captures any nesting
// of key=value fields and child sections without naming individual keys, so it
// round-trips arbitrary TDF documents losslessly. Use it to model formats whose
// schema is dynamic or not worth enumerating field by field (sound classes,
// particle effects, font kerning tables, keyboard maps, ...).
type Section struct {
	Key string `tdf:",name"`

	// Values holds this section's scalar key=value pairs.
	Values map[string]string `tdf:",remaining"`

	// Children holds this section's nested sub-sections, recursively.
	Children []Section `tdf:",sections"`
}
