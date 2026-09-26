package studio

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot/internal/mapmeta"
)

// The map editor's .ota round trip.
//
// Loading reads the file through kbot-io's OTA game view (readOTAState): the
// schemas the game finds (Schema 0, Schema 1, ... up to the first missing
// number) and each one's start positions, numbered the game's way. Every
// schema and start position remembers where it came from, and the state
// carries the file itself (otaState.Source).
//
// Saving edits that file in place (editOTA): only the values the editor
// changed are rewritten, and new schemas and start positions are added.
// Every other key, section, comment and value is kept byte for byte: the
// economy fractions, victory conditions, [units], [features], other
// [specials] entries and keys the editor does not model. Removing a schema or
// a start position is the one edit a text splice cannot make; the file is
// then decoded into kbot-io's ta structs, whose Meta keeps every key and
// value as read, the entries are removed and the file is written back in
// kbot-io's layout. A file kbot-io cannot read or edit is never overwritten:
// the save keeps it unchanged and reports why. A save that would make the
// game read a schema section it skips now is refused (see
// schemasMadeReadable).

// Key spellings written for keys the source does not have yet, following
// the game's own maps.
const (
	otaKeySchemaCount = "SCHEMACOUNT"
	otaStartPosPrefix = "StartPos"
)

// otaEditError reports an editor change the .ota cannot take, which the
// user can correct: text the game would read back differently (see
// tdf.CheckValue), or schemas the save would number so that the game reads
// a section it skips now.
type otaEditError struct {
	field string
	err   error
}

func (e *otaEditError) Error() string { return fmt.Sprintf("%s: %v", e.field, e.err) }
func (e *otaEditError) Unwrap() error { return e.err }

// editorFloat returns a fraction as the editor holds it. The game reads a
// value too large for a double, such as 1e999, as infinity, which JSON
// cannot carry: the editor holds it as the largest double, and a save
// leaves such a value as the file has it unless the user changes it (see
// setFloat).
func editorFloat(v float64) float64 {
	switch {
	case math.IsInf(v, 1):
		return math.MaxFloat64
	case math.IsInf(v, -1):
		return -math.MaxFloat64
	case math.IsNaN(v):
		return 0
	}
	return v
}

// readOTAState reads a Total Annihilation .ota into the editor's state. The
// schemas are the ones the game finds, in number order; each one's start
// positions are the [specials] entries whose specialwhat starts with StartPos
// (ignoring case), numbered as the game numbers them (StartPos0 and entries
// with no number kept) and listed in player-slot order. Values the game reads
// as fractions (tidalstrength, killmul, timemul and the meteor settings) keep
// their fractions; an infinite one is held as editorFloat gives it.
//
// A file kbot-io cannot read gives a state with Error set, Source holding the
// file and nothing else; a save then leaves the file unchanged.
func readOTAState(data []byte) *otaState {
	st := &otaState{Source: base64.StdEncoding.EncodeToString(data)}
	m, err := mapmeta.ReadOTA(data)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	h := &m.Header
	st.MissionName = h.MissionName
	st.MissionDescription = h.MissionDescription
	st.MissionHint = h.MissionHint
	st.Brief = h.Brief
	st.Narration = h.Narration
	st.Glamour = h.Glamour
	st.Planet = h.Planet
	st.NumPlayers = h.NumPlayersText()
	st.Size = h.Size
	st.Memory = h.Memory
	st.LineOfSight = h.LineOfSight
	st.Mapping = h.Mapping
	st.TidalStrength = editorFloat(h.EffectiveTidalStrength())
	st.SolarStrength = h.SolarStrength
	st.LavaWorld = h.LavaWorld
	st.Killmul = editorFloat(h.EffectiveKillMul())
	st.Timemul = editorFloat(h.EffectiveTimeMul())
	st.MinWindSpeed = h.MinWindSpeed
	st.MaxWindSpeed = h.MaxWindSpeed
	st.Gravity = h.Gravity
	st.SeaLevel = h.SeaLevel
	st.ImpassibleWater = h.ImpassibleWater
	st.WaterDoesDamage = h.WaterDoesDamage
	st.UnreachableSchemas = h.UnreachableSchemas()
	st.Schemas = []otaSchema{}
	for n, s := range h.GameSchemas() {
		src := n
		schema := schemaState(s, 1)
		schema.Name = strconv.Itoa(n)
		schema.Source = &src
		st.Schemas = append(st.Schemas, schema)
	}
	return st
}

// readKingdomsOTAState reads a TA: Kingdoms .ota for the editor: its header
// text and the [Map Data] setup as the one schema, with start positions
// converted from 16-pixel data units to the editor's pixels. The TA: Kingdoms
// save ships the .ota unchanged, so the state carries no Source.
func readKingdomsOTAState(data []byte) *otaState {
	st := &otaState{Schemas: []otaSchema{}}
	if m, err := mapmeta.ReadOTA(data); err == nil {
		h := &m.Header
		st.MissionName = h.MissionName
		st.MissionDescription = h.MissionDescription
		st.NumPlayers = h.NumPlayersText()
		st.Size = h.Size
		st.Memory = h.Memory
		st.SeaLevel = h.SeaLevel
	}
	setup, err := mapmeta.KingdomsSetup(data)
	if err != nil {
		st.Error = err.Error()
		return st
	}
	if setup != nil {
		schema := schemaState(setup, 16)
		schema.Name = "Map Data"
		st.Schemas = append(st.Schemas, schema)
	}
	return st
}

// schemaState converts one schema to the editor's form, scaling start
// positions by scale (1 for pixels).
func schemaState(s *ta.Schema, scale int) otaSchema {
	out := otaSchema{
		Type:           s.Type,
		AIProfile:      s.AIProfile,
		SurfaceMetal:   s.SurfaceMetal,
		MohoMetal:      s.MohoMetal,
		HumanMetal:     s.HumanMetal,
		ComputerMetal:  s.ComputerMetal,
		HumanEnergy:    s.HumanEnergy,
		ComputerEnergy: s.ComputerEnergy,
		MeteorWeapon:   s.MeteorWeapon,
		MeteorRadius:   s.MeteorRadius,
		MeteorDensity:  editorFloat(s.MeteorDensity),
		MeteorDuration: editorFloat(s.EffectiveMeteorDuration()),
		MeteorInterval: editorFloat(s.EffectiveMeteorInterval()),
		StartPos:       []saveStartPos{},
	}
	for _, p := range mapmeta.StartPositions(s) {
		idx := specialIndex(s, p.Special)
		out.StartPos = append(out.StartPos, saveStartPos{
			Number:  p.Number,
			X:       p.X * scale,
			Z:       p.Z * scale,
			Special: &idx,
		})
	}
	return out
}

// specialIndex returns the position of sp among the schema's [specials]
// entries, or -1.
func specialIndex(s *ta.Schema, sp *ta.Special) int {
	if s.Specials == nil {
		return -1
	}
	for i := range s.Specials.Items {
		if &s.Specials.Items[i] == sp {
			return i
		}
	}
	return -1
}

// otaEditor applies an editor state to a parsed .ota.
type otaEditor struct {
	doc   *tdf.Document
	fresh bool // a new file: every modelled key is written

	// from[i] is the source schema number the editor's schema i was read
	// from, or -1 for a schema the save adds (see planSchemas)
	from []int

	// removals the text splice cannot make, applied afterwards
	dropSchemas  []int         // source schema numbers
	dropSpecials map[int][]int // source schema number -> [specials] indices
}

// editOTA returns the .ota text for the editor state st. With a source file
// (src non-nil) it is that file edited in place, as described at the top of
// this file; without one it is a new file holding every modelled key. It
// returns an *otaEditError for editor text the file cannot hold or schemas
// the game would read differently, and another error when the source cannot
// be read or edited; the caller then keeps the source unchanged.
func editOTA(src []byte, st *otaState) ([]byte, error) {
	e := &otaEditor{dropSpecials: map[int][]int{}}
	var game []*ta.Schema
	var hdr *tdf.Section
	if src == nil {
		e.fresh = true
		e.doc = tdf.NewDocument()
		hdr = e.doc.AddSection("GlobalHeader")
		e.from, _ = planSchemas(st, 0)
	} else {
		m, err := mapmeta.ReadOTA(src)
		if err != nil {
			return nil, err
		}
		game = m.Header.GameSchemas()
		e.from, e.dropSchemas = planSchemas(st, len(game))
		added := 0
		for _, n := range e.from {
			if n < 0 {
				added++
			}
		}
		if names := schemasMadeReadable(&m.Header, added, e.dropSchemas); len(names) > 0 {
			return nil, schemasMadeReadableError(names)
		}
		if e.doc, err = tdf.Parse(bytes.NewReader(src)); err != nil {
			return nil, err
		}
		if hdr = e.doc.Section("GlobalHeader"); hdr == nil {
			return nil, ta.ErrNoGlobalHeader
		}
	}
	if err := e.header(hdr, st); err != nil {
		return nil, err
	}
	if err := e.schemas(hdr, st, game); err != nil {
		return nil, err
	}
	out, err := e.doc.Bytes()
	if err != nil {
		return nil, err
	}
	if len(e.dropSchemas) > 0 || len(e.dropSpecials) > 0 {
		if out, err = e.remove(out); err != nil {
			return nil, err
		}
	}
	if err := checkOTAResult(out, st); err != nil {
		return nil, err
	}
	return out, nil
}

// header writes the [GlobalHeader] values the editor models.
func (e *otaEditor) header(h *tdf.Section, st *otaState) error {
	texts := []struct{ key, want string }{
		{"missionname", st.MissionName},
		{"missiondescription", st.MissionDescription},
		{"planet", st.Planet},
		{"missionhint", st.MissionHint},
		{"brief", st.Brief},
		{"narration", st.Narration},
		{"glamour", st.Glamour},
	}
	for _, t := range texts {
		if err := e.setText(h, t.key, t.want); err != nil {
			return err
		}
	}
	e.setInt(h, "lineofsight", st.LineOfSight)
	e.setInt(h, "mapping", st.Mapping)
	e.setFloat(h, "tidalstrength", st.TidalStrength)
	e.setInt(h, "solarstrength", st.SolarStrength)
	e.setInt(h, "lavaworld", st.LavaWorld)
	e.setFloat(h, "killmul", st.Killmul)
	e.setFloat(h, "timemul", st.Timemul)
	e.setInt(h, "minwindspeed", st.MinWindSpeed)
	e.setInt(h, "maxwindspeed", st.MaxWindSpeed)
	e.setInt(h, "gravity", st.Gravity)
	// The game takes the sea level from the .tnt header, never from the
	// .ota; an existing sealevel key is kept in step with it, but none is
	// added to a file that has none.
	if e.fresh || h.Has("sealevel") {
		e.setInt(h, "sealevel", st.SeaLevel)
	}
	e.setInt(h, "impassiblewater", st.ImpassibleWater)
	e.setInt(h, "waterdoesdamage", st.WaterDoesDamage)
	for _, t := range []struct{ key, want string }{
		{"numplayers", st.NumPlayers},
		{"size", st.Size},
		{"memory", st.Memory},
	} {
		if err := e.setText(h, t.key, t.want); err != nil {
			return err
		}
	}
	return nil
}

// setText sets a text value that differs from the section's (a missing key
// reads as empty), after checking the game reads it back unchanged.
func (e *otaEditor) setText(s *tdf.Section, key, want string) error {
	cur, ok := s.Get(key)
	if !e.fresh && cur == want && (ok || want == "") {
		return nil
	}
	if err := tdf.CheckValue(want); err != nil {
		return &otaEditError{field: key, err: err}
	}
	s.Set(key, want)
	return nil
}

// setInt sets an integer that differs from the section's value as the game
// reads it (Atol; a missing key reads as 0).
func (e *otaEditor) setInt(s *tdf.Section, key string, want int) {
	cur, ok := s.Get(key)
	if !e.fresh && int(tdf.Atol(cur)) == want && (ok || want == 0) {
		return
	}
	s.SetInt(key, want)
}

// setFloat sets a fraction that differs from the section's value as the
// game reads it (Atof; a missing key reads as 0), compared as the editor
// holds it (editorFloat).
func (e *otaEditor) setFloat(s *tdf.Section, key string, want float64) {
	cur, ok := s.Get(key)
	if !e.fresh && editorFloat(tdf.Atof(cur)) == want && (ok || want == 0) {
		return
	}
	s.SetFloat(key, want)
}

// schemaPrefix begins the name of every schema section.
const schemaPrefix = "Schema "

// schemas edits the schemas the source had, adds the editor's new ones and
// records the source schemas the editor removed (see planSchemas).
func (e *otaEditor) schemas(h *tdf.Section, st *otaState, game []*ta.Schema) error {
	before := countSchemaSections(h)
	if e.fresh {
		h.SetInt(otaKeySchemaCount, len(st.Schemas))
	}
	for i := range st.Schemas {
		s := &st.Schemas[i]
		if n := e.from[i]; n >= 0 {
			sec := h.Section(schemaPrefix + strconv.Itoa(n))
			if sec == nil {
				return fmt.Errorf("schema %d not found in the .ota text", n)
			}
			if err := e.schema(sec, s, false); err != nil {
				return err
			}
			if err := e.starts(sec, s, n, game[n]); err != nil {
				return err
			}
			continue
		}
		sec := h.AddSection(nextSchemaName(schemaSectionNames(h)))
		if err := e.schema(sec, s, true); err != nil {
			return err
		}
		if err := e.starts(sec, s, -1, nil); err != nil {
			return err
		}
	}
	// The game ignores SCHEMACOUNT; like kbot-io, keep an existing one in
	// step with the number of schema sections, and write one in a new file.
	if after := countSchemaSections(h); !e.fresh && h.Has(otaKeySchemaCount) && after != before {
		h.SetInt(otaKeySchemaCount, after)
	}
	return nil
}

// planSchemas maps the editor's schemas onto the source's count game
// schemas: from[i] is the source number the editor's schema i was read
// from, or -1 for a schema the save adds (as is a second schema claiming
// the same source), and drop lists the source numbers no editor schema
// keeps, in increasing order.
func planSchemas(st *otaState, count int) (from, drop []int) {
	kept := make([]bool, count)
	from = make([]int, len(st.Schemas))
	for i := range st.Schemas {
		n := sourceSchema(&st.Schemas[i], count)
		if n >= 0 && kept[n] {
			n = -1
		}
		if n >= 0 {
			kept[n] = true
		}
		from[i] = n
	}
	for n, k := range kept {
		if !k {
			drop = append(drop, n)
		}
	}
	return from, drop
}

// nextSchemaName returns the name a new schema section is written under:
// "Schema N" with N the lowest number no section in names uses (compared
// ignoring case, see tdf.ElementNames).
func nextSchemaName(names []string) string {
	return tdf.ElementNames(schemaPrefix, append(names[:len(names):len(names)], ""))[len(names)]
}

// schemasMadeReadable returns the names of the source header's schema
// sections the game skips now but would read after a save that adds added
// schemas and removes the game schemas numbered in drop. Adding a schema
// takes the lowest free number, which fills the first gap in the numbering,
// so the game then reads on into the sections after the gap; removing one
// renumbers the game's schemas after it, which can put a section repeating a
// number first. It runs the save's own numbering (the additions editOTA
// splices in, then dropGameSchema) on the section names alone.
func schemasMadeReadable(h *ta.GlobalHeader, added int, drop []int) []string {
	read := map[*ta.Schema]bool{}
	for _, s := range h.GameSchemas() {
		read[s] = true
	}
	sim := &ta.GlobalHeader{}
	var skipped []string // per sim schema: its name when the game skips it now
	for i := range h.Schemas {
		sim.Schemas = append(sim.Schemas, ta.Schema{Key: h.Schemas[i].Key})
		name := ""
		if !read[&h.Schemas[i]] {
			name = h.Schemas[i].Key
		}
		skipped = append(skipped, name)
	}
	for ; added > 0; added-- {
		names := make([]string, len(sim.Schemas))
		for i := range sim.Schemas {
			names[i] = sim.Schemas[i].Key
		}
		sim.Schemas = append(sim.Schemas, ta.Schema{Key: nextSchemaName(names)})
		skipped = append(skipped, "")
	}
	for _, n := range descending(drop) {
		i, ok := dropGameSchema(sim, n)
		if !ok {
			return nil
		}
		skipped = append(skipped[:i:i], skipped[i+1:]...)
	}
	var out []string
	for _, s := range sim.GameSchemas() {
		for i := range sim.Schemas {
			if &sim.Schemas[i] == s && skipped[i] != "" {
				out = append(out, skipped[i])
			}
		}
	}
	return out
}

// schemasMadeReadableError tells the user which skipped schema sections a
// save would bring into the game's reach (see schemasMadeReadable).
func schemasMadeReadableError(names []string) error {
	them := "it"
	if len(names) > 1 {
		them = "them"
	}
	return &otaEditError{field: "schemas", err: fmt.Errorf(
		"this save would make the game read [%s], which it skips now (after a gap in the schema numbers, or as a repeated number); "+
			"rename or remove %s in the .ota, or save without adding or removing schemas",
		strings.Join(names, "], ["), them)}
}

// dropGameSchema removes the schema the game reads as Schema n from h and
// renames the game's schemas after it down a number, so the game still
// reads each of them; sections the game skips keep their names. It returns
// the index the removed schema had in h.Schemas, or false when the game
// reads no Schema n.
func dropGameSchema(h *ta.GlobalHeader, n int) (int, bool) {
	game := h.GameSchemas()
	if n < 0 || n >= len(game) {
		return 0, false
	}
	// Rename the later game schemas before removing, while the pointers
	// still address them.
	for j := len(game) - 1; j > n; j-- {
		game[j].Key = schemaPrefix + strconv.Itoa(j-1)
	}
	for i := range h.Schemas {
		if &h.Schemas[i] == game[n] {
			h.Schemas = append(h.Schemas[:i:i], h.Schemas[i+1:]...)
			return i, true
		}
	}
	return 0, false
}

// descending returns a sorted copy of ns, largest first.
func descending(ns []int) []int {
	out := append([]int(nil), ns...)
	sort.Sort(sort.Reverse(sort.IntSlice(out)))
	return out
}

// sourceSchema returns the source schema number an editor schema was read
// from, or -1 for a schema the editor added.
func sourceSchema(s *otaSchema, count int) int {
	if s.Source == nil || *s.Source < 0 || *s.Source >= count {
		return -1
	}
	return *s.Source
}

// schemaSectionNames returns the names of the header's schema sections
// (names starting with "Schema ", ignoring case), as kbot-io's
// GlobalHeader.Schemas holds them.
func schemaSectionNames(h *tdf.Section) []string {
	var names []string
	for _, c := range h.Sections() {
		if len(c.Name()) >= len(schemaPrefix) && strings.EqualFold(c.Name()[:len(schemaPrefix)], schemaPrefix) {
			names = append(names, c.Name())
		}
	}
	return names
}

func countSchemaSections(h *tdf.Section) int { return len(schemaSectionNames(h)) }

// schema writes one schema's values; fresh writes every one (a new schema).
func (e *otaEditor) schema(sec *tdf.Section, s *otaSchema, fresh bool) error {
	sub := &otaEditor{doc: e.doc, fresh: e.fresh || fresh}
	for _, t := range []struct{ key, want string }{
		{"Type", s.Type},
		{"aiprofile", s.AIProfile},
	} {
		if err := sub.setText(sec, t.key, t.want); err != nil {
			return err
		}
	}
	sub.setInt(sec, "SurfaceMetal", s.SurfaceMetal)
	sub.setInt(sec, "MohoMetal", s.MohoMetal)
	sub.setInt(sec, "HumanMetal", s.HumanMetal)
	sub.setInt(sec, "ComputerMetal", s.ComputerMetal)
	sub.setInt(sec, "HumanEnergy", s.HumanEnergy)
	sub.setInt(sec, "ComputerEnergy", s.ComputerEnergy)
	if err := sub.setText(sec, "MeteorWeapon", s.MeteorWeapon); err != nil {
		return err
	}
	sub.setInt(sec, "MeteorRadius", s.MeteorRadius)
	sub.setFloat(sec, "MeteorDensity", s.MeteorDensity)
	sub.setFloat(sec, "MeteorDuration", s.MeteorDuration)
	sub.setFloat(sec, "MeteorInterval", s.MeteorInterval)
	return nil
}

// starts edits a schema's start positions: moved or renumbered positions
// the source had are updated in place, new ones are added to [specials] and
// removed ones are recorded. n is the source schema number (-1 for a new
// schema) and game its game view.
func (e *otaEditor) starts(sec *tdf.Section, s *otaSchema, n int, game *ta.Schema) error {
	var specials *tdf.Section
	if sec != nil {
		specials = sec.Section("specials")
	}
	// The source's start positions by [specials] index.
	orig := map[int]ta.StartPosition{}
	if game != nil {
		for _, p := range game.StartPositions() {
			orig[specialIndex(game, p.Special)] = p
		}
		if specials != nil && game.Specials != nil && len(specials.Sections()) != len(game.Specials.Items) {
			return fmt.Errorf("schema %d: [specials] entries do not match the .ota text", n)
		}
	}
	kept := map[int]int{} // [specials] index -> the editor's number
	for _, sp := range s.StartPos {
		if sp.Special != nil {
			_, dup := kept[*sp.Special]
			if p, ok := orig[*sp.Special]; ok && !dup && specials != nil {
				kept[*sp.Special] = sp.Number
				item := specials.Sections()[*sp.Special]
				if sp.Number != p.Number {
					item.Set("specialwhat", otaStartPosPrefix+strconv.Itoa(sp.Number))
				}
				if sp.X != p.X {
					item.SetInt("XPos", sp.X)
				}
				if sp.Z != p.Z {
					item.SetInt("ZPos", sp.Z)
				}
				continue
			}
		}
		if specials == nil {
			specials = sec.AddSection("specials")
		}
		var names []string
		for _, c := range specials.Sections() {
			names = append(names, c.Name())
		}
		name := tdf.ElementNames("special", append(names, ""))[len(names)]
		item := specials.AddSection(name)
		item.Set("specialwhat", otaStartPosPrefix+strconv.Itoa(sp.Number))
		item.SetInt("XPos", sp.X)
		item.SetInt("ZPos", sp.Z)
	}
	for idx := range orig {
		if _, ok := kept[idx]; !ok {
			e.dropSpecials[n] = append(e.dropSpecials[n], idx)
		}
	}
	// The game numbers a StartPos entry with no digits by its place among
	// such entries, so removing or numbering one shifts the ones after it:
	// write those numbers out.
	if specials != nil {
		implicit := 0
		for i, item := range specials.Sections() {
			num, ok := kept[i]
			if !ok {
				continue
			}
			if what, _ := item.Get("specialwhat"); !unnumberedStart(what) {
				continue
			}
			implicit++
			if implicit != num {
				item.Set("specialwhat", otaStartPosPrefix+strconv.Itoa(num))
			}
		}
	}
	return nil
}

// unnumberedStart reports whether a specialwhat value is a start position
// with no number: StartPos (ignoring case) not followed by a digit.
func unnumberedStart(what string) bool {
	if len(what) > 255 {
		what = what[:255]
	}
	if len(what) < len(otaStartPosPrefix) || !strings.EqualFold(what[:len(otaStartPosPrefix)], otaStartPosPrefix) {
		return false
	}
	rest := what[len(otaStartPosPrefix):]
	return rest == "" || rest[0] < '0' || rest[0] > '9'
}

// remove applies the recorded removals to the spliced text: it decodes the
// file into kbot-io's ta structs (whose Meta keeps every key, value and
// section as read), removes the start positions and schemas and writes the
// file back. The schemas after a removed one move down a number, so the game
// still finds every one; schemas the game already never read keep their
// names (see dropGameSchema).
func (e *otaEditor) remove(text []byte) ([]byte, error) {
	m, err := ta.ReadMap(text)
	if err != nil {
		return nil, err
	}
	h := &m.Header
	for n, idxs := range e.dropSpecials {
		s := h.Schema(n)
		if s == nil || s.Specials == nil {
			return nil, fmt.Errorf("schema %d: [specials] not found", n)
		}
		sort.Sort(sort.Reverse(sort.IntSlice(idxs)))
		for _, i := range idxs {
			if i < 0 || i >= len(s.Specials.Items) {
				return nil, fmt.Errorf("schema %d: no [specials] entry %d", n, i)
			}
			s.Specials.Items = append(s.Specials.Items[:i:i], s.Specials.Items[i+1:]...)
		}
	}
	for _, n := range descending(e.dropSchemas) {
		if _, ok := dropGameSchema(h, n); !ok {
			return nil, fmt.Errorf("schema %d not found", n)
		}
	}
	if len(e.dropSchemas) > 0 {
		for k := range h.Remaining {
			if strings.EqualFold(k, otaKeySchemaCount) {
				h.Remaining[k] = strconv.Itoa(len(h.Schemas))
			}
		}
	}
	return tdf.Marshal(m)
}

// errOTAMismatch reports an edit that would not read back as the editor
// state; the file is then kept unchanged.
var errOTAMismatch = errors.New("the edited .ota does not read back as the editor's state")

// checkOTAResult reads the written text back through the game view and
// checks it holds the editor's header text, schemas and start positions.
func checkOTAResult(out []byte, st *otaState) error {
	m, err := mapmeta.ReadOTA(out)
	if err != nil {
		return fmt.Errorf("%w: %v", errOTAMismatch, err)
	}
	h := &m.Header
	for _, c := range []struct{ got, want, key string }{
		{h.MissionName, st.MissionName, "missionname"},
		{h.MissionDescription, st.MissionDescription, "missiondescription"},
		{h.Planet, st.Planet, "planet"},
		{h.NumPlayersText(), st.NumPlayers, "numplayers"},
	} {
		if c.got != c.want {
			return fmt.Errorf("%w: %s is %q, want %q", errOTAMismatch, c.key, c.got, c.want)
		}
	}
	game := h.GameSchemas()
	if len(game) != len(st.Schemas) {
		return fmt.Errorf("%w: %d schemas, want %d", errOTAMismatch, len(game), len(st.Schemas))
	}
	for i, s := range game {
		if s.Type != st.Schemas[i].Type {
			return fmt.Errorf("%w: schema %d type %q, want %q", errOTAMismatch, i, s.Type, st.Schemas[i].Type)
		}
		want := startKeys(st.Schemas[i].StartPos)
		var got []string
		for _, p := range s.StartPositions() {
			got = append(got, fmt.Sprintf("%d:%d,%d", p.Number, p.X, p.Z))
		}
		sort.Strings(got)
		if strings.Join(got, " ") != strings.Join(want, " ") {
			return fmt.Errorf("%w: schema %d start positions %v, want %v", errOTAMismatch, i, got, want)
		}
	}
	return nil
}

// startKeys lists start positions as the game view reads them back (X and Z
// kept to 16 bits), sorted.
func startKeys(sps []saveStartPos) []string {
	out := make([]string, 0, len(sps))
	for _, sp := range sps {
		out = append(out, fmt.Sprintf("%d:%d,%d", sp.Number, int16(sp.X), int16(sp.Z)))
	}
	sort.Strings(out)
	return out
}

// loadedOTAState reads a map's .ota for the editor (see readOTAState and
// readKingdomsOTAState). For a TA map the editor's sea level is the .tnt
// header's, the one the game uses. A TA:K map keeps its sea level in the
// header slot TA uses for the tile-map pointer; its .ota normally has none.
func loadedOTAState(data []byte, m *tnt.Map) *otaState {
	if m.IsTAK {
		st := readKingdomsOTAState(data)
		if st.SeaLevel == 0 {
			st.SeaLevel = int(m.Header.PTRMapData)
		}
		return st
	}
	st := readOTAState(data)
	st.SeaLevel = int(m.Header.SeaLevel)
	return st
}

// otaForSave returns the .ota a save writes for req, and a warning for the
// user when the source file is kept unchanged because it could not be read
// or edited in place. An editor change the file cannot take is an
// *otaEditError.
// A request with no source file (a new map) gets a new .ota.
func otaForSave(req saveRequest) ([]byte, string, error) {
	if req.OTA != nil && req.OTA.Source != "" {
		src, err := base64.StdEncoding.DecodeString(req.OTA.Source)
		if err != nil {
			return nil, "", fmt.Errorf("ota source: %w", err)
		}
		out, err := editOTA(src, req.OTA)
		var editErr *otaEditError
		if errors.As(err, &editErr) {
			return nil, "", err
		}
		if err != nil {
			return src, fmt.Sprintf("the map's .ota was kept unchanged because it could not be edited: %v", err), nil
		}
		return out, "", nil
	}
	st := otaForRequest(req)
	st.Source = ""
	out, err := editOTA(nil, &st)
	return out, "", err
}

// saveErrorStatus is the HTTP status for a failed save: 400 for an editor
// change the .ota cannot take, which the user can fix, 500 otherwise.
func saveErrorStatus(err error) int {
	var editErr *otaEditError
	if errors.As(err, &editErr) {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

// setWarningHeader passes save warnings on a download response in the
// X-Kbot-Warning header, as printable ASCII.
func setWarningHeader(w http.ResponseWriter, warnings []string) {
	if len(warnings) == 0 {
		return
	}
	msg := []byte(strings.Join(warnings, "; "))
	for i, c := range msg {
		if c < 0x20 || c > 0x7e {
			msg[i] = '?'
		}
	}
	w.Header().Set("X-Kbot-Warning", string(msg))
}

// packOTAState reads a map's .ota for a static pack: the editor's state
// without the source file, or nil when kbot-io cannot read it.
func packOTAState(data []byte, isTAK bool) *otaState {
	var st *otaState
	if isTAK {
		st = readKingdomsOTAState(data)
	} else {
		st = readOTAState(data)
	}
	if st.Error != "" {
		return nil
	}
	st.Source = ""
	return st
}
