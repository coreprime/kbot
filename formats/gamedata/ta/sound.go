package ta

// SoundClass is one section of gamedata/sound.tdf: a named set of game-event to
// sound-sample mappings (e.g. [ARM_KBOT] { select1=kbarmsel; ok1=kbarmmov; }).
// The event keys are open-ended, so every key=value is captured in Events.
// Decode the whole file with
//
//	var classes []ta.SoundClass
//	err := tdf.Unmarshal(data, &classes)
type SoundClass struct {
	Key string `tdf:",name"` // section header, e.g. "ARM_KBOT"

	// Events maps each game event (select1, ok1, underattack, ...) to its sound
	// sample. It captures every key in the section so the file round-trips.
	Events map[string]string `tdf:",remaining"`
}

// SoundEvent is one section of gamedata/allsound.tdf: a named UI/game event
// mapped to a single sound sample. Decode the whole file with
//
//	var events []ta.SoundEvent
//	err := tdf.Unmarshal(data, &events)
type SoundEvent struct {
	Key string `tdf:",name"` // section header, e.g. "BGM"

	Sound string `tdf:"sound,omitempty"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}
