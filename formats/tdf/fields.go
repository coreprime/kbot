package tdf

import (
	"reflect"
	"strings"
	"sync"
)

// fieldCat classifies how a struct field maps onto TDF syntax.
type fieldCat int

const (
	catScalar     fieldCat = iota // string / number / bool (or pointer to one)
	catScalarList                 // slice of scalars -> space-separated value
	catSection                    // struct (or *struct) -> nested [name]{ }
	catRepeated                   // slice of struct -> repeated [name]{ } blocks
	catMap                        // map[string]scalar -> dynamic-keyed section
)

// fieldSpec describes one tagged struct field. index is the reflect field path
// from the spec's root struct, so promoted fields of anonymous embedded structs
// are reachable via reflect.Value.FieldByIndex.
type fieldSpec struct {
	index       []int
	key         string // original-case tag key, used when emitting
	ukey        string // upper-cased key, used when matching (TDF is case-insensitive)
	omitempty   bool
	isName      bool   // captures/emits the enclosing section's header name
	isRemaining bool   // map[string]string catch-all for unmatched scalar keys
	isSections  bool   // []struct catch-all for unmatched child sections
	countKey    string // for repeated sections: sibling scalar key holding the count
	delimiter   string // for scalar slices: the value separator (default whitespace)
}

// structSpec is the cached tag layout of a struct type. The name/remaining
// index paths are nil when the struct (including its embedded bases) has no
// such field.
type structSpec struct {
	fields         []fieldSpec
	nameIndex      []int
	remainingIndex []int
	sectionsIndex  []int
	countKeys      map[string]bool // upper-cased sibling count keys managed by repeats= fields
}

var specCache sync.Map // reflect.Type -> structSpec

func specFor(t reflect.Type) structSpec {
	if v, ok := specCache.Load(t); ok {
		return v.(structSpec)
	}
	s := buildSpec(t)
	specCache.Store(t, s)
	return s
}

func buildSpec(t reflect.Type) structSpec {
	var s structSpec
	collectFields(t, nil, &s)
	return s
}

// collectFields walks t's exported tagged fields into s, recursing into
// anonymous untagged embedded structs so their fields are promoted with a full
// index path. prefix is the field path to t from the spec root.
func collectFields(t reflect.Type, prefix []int, s *structSpec) {
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" && !f.Anonymous { // unexported, non-embedded
			continue
		}
		tag, hasTag := f.Tag.Lookup("tdf")

		// An anonymous embedded struct with no tdf tag contributes its own
		// fields to the parent (like Go field promotion / encoding/json).
		if f.Anonymous && !hasTag {
			et := f.Type
			if et.Kind() == reflect.Pointer {
				et = et.Elem()
			}
			if et.Kind() == reflect.Struct {
				collectFields(et, appendIndex(prefix, i), s)
				continue
			}
		}
		if !hasTag || tag == "-" {
			continue
		}
		parts := splitTagOptions(tag)
		fs := fieldSpec{
			index: appendIndex(prefix, i),
			key:   strings.TrimSpace(parts[0]),
			ukey:  strings.ToUpper(strings.TrimSpace(parts[0])),
		}
		for _, o := range parts[1:] {
			o = strings.TrimSpace(o)
			switch {
			case o == "omitempty":
				fs.omitempty = true
			case o == "name":
				fs.isName = true
			case o == "remaining":
				fs.isRemaining = true
			case o == "sections":
				fs.isSections = true
			case strings.HasPrefix(o, "repeats="):
				fs.countKey = strings.TrimSpace(strings.TrimPrefix(o, "repeats="))
			case strings.HasPrefix(o, "delimiter="):
				fs.delimiter = unquoteTagValue(strings.TrimPrefix(o, "delimiter="))
			}
		}
		if fs.isName {
			s.nameIndex = fs.index
		}
		if fs.isRemaining {
			s.remainingIndex = fs.index
		}
		if fs.isSections {
			s.sectionsIndex = fs.index
		}
		if fs.countKey != "" {
			if s.countKeys == nil {
				s.countKeys = map[string]bool{}
			}
			s.countKeys[strings.ToUpper(fs.countKey)] = true
		}
		s.fields = append(s.fields, fs)
	}
}

// splitTagOptions splits a tdf tag on commas, except commas inside single
// quotes so an option value can itself contain a comma (e.g. delimiter=', ').
func splitTagOptions(tag string) []string {
	var parts []string
	var b strings.Builder
	inQuote := false
	for _, r := range tag {
		switch {
		case r == '\'':
			inQuote = !inQuote
			b.WriteRune(r)
		case r == ',' && !inQuote:
			parts = append(parts, b.String())
			b.Reset()
		default:
			b.WriteRune(r)
		}
	}
	return append(parts, b.String())
}

// unquoteTagValue strips a single pair of surrounding single quotes, letting a
// tag option carry leading/trailing spaces (e.g. delimiter=', ').
func unquoteTagValue(s string) string {
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return s[1 : len(s)-1]
	}
	return s
}

// appendIndex returns prefix+[i] in a fresh slice so cached specs never alias
// a shared backing array.
func appendIndex(prefix []int, i int) []int {
	out := make([]int, len(prefix)+1)
	copy(out, prefix)
	out[len(prefix)] = i
	return out
}

// fieldByName returns the first non-special tagged field matching name.
func (s structSpec) fieldByName(name string) (fieldSpec, bool) {
	u := strings.ToUpper(name)
	for _, fs := range s.fields {
		if fs.isName || fs.isRemaining || fs.isSections {
			continue
		}
		if fs.ukey == u {
			return fs, true
		}
	}
	return fieldSpec{}, false
}

func categorize(t reflect.Type) fieldCat {
	if isCustomScalar(t) {
		return catScalar
	}
	switch t.Kind() {
	case reflect.Pointer:
		et := t.Elem()
		if isScalarKind(et.Kind()) {
			return catScalar
		}
		if et.Kind() == reflect.Struct {
			return catSection
		}
		return categorize(et)
	case reflect.Slice:
		if derefStruct(t.Elem()) {
			return catRepeated
		}
		return catScalarList
	case reflect.Map:
		return catMap
	case reflect.Struct:
		return catSection
	default:
		return catScalar
	}
}

func isScalarKind(k reflect.Kind) bool {
	switch k {
	case reflect.String, reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return true
	default:
		return false
	}
}

// derefStruct reports whether t (after one pointer hop) is a struct.
func derefStruct(t reflect.Type) bool {
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t.Kind() == reflect.Struct
}
