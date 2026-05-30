package tdf

import (
	"fmt"
	"reflect"
)

// MisparsedKeys walks an already-decoded value and reports keys that fell
// through to a ",remaining" catch-all map even though the enclosing struct
// declares a typed field for that key. Unmarshal routes a value to the catch-all
// when it cannot be parsed into its declared field type (see decodeFieldChild),
// so the document still round-trips losslessly. Because the value is preserved,
// a byte-level round-trip check cannot reveal the mismatch — but it means the
// value landed in the catch-all instead of the field it was meant for, which is
// almost always a mis-typed struct field (or genuinely malformed game data).
//
// Each result is formatted as "Type.key=value".
func MisparsedKeys(v any) []string {
	var out []string
	seen := map[string]bool{}
	walkMisparse(reflect.ValueOf(v), &out, seen)
	return out
}

func walkMisparse(rv reflect.Value, out *[]string, seen map[string]bool) {
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !rv.IsNil() {
			walkMisparse(rv.Elem(), out, seen)
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			walkMisparse(rv.Index(i), out, seen)
		}
	case reflect.Map:
		for _, k := range rv.MapKeys() {
			walkMisparse(rv.MapIndex(k), out, seen)
		}
	case reflect.Struct:
		spec := specFor(rv.Type())
		if spec.remainingIndex != nil {
			rem := rv.FieldByIndex(spec.remainingIndex)
			if rem.Kind() == reflect.Map && !rem.IsNil() {
				id := rem.Pointer()
				for _, k := range rem.MapKeys() {
					name := k.String()
					if _, ok := spec.fieldByName(name); !ok {
						continue
					}
					// The catch-all map is shared with embedded bases, so the
					// same (map, key) can be visited via several struct levels.
					dedup := fmt.Sprintf("%x|%s", id, name)
					if seen[dedup] {
						continue
					}
					seen[dedup] = true
					*out = append(*out, fmt.Sprintf("%s.%s=%s",
						rv.Type().Name(), name, rem.MapIndex(k).String()))
				}
			}
		}
		for i := 0; i < rv.NumField(); i++ {
			f := rv.Type().Field(i)
			if f.PkgPath != "" && !f.Anonymous {
				continue
			}
			walkMisparse(rv.Field(i), out, seen)
		}
	}
}
