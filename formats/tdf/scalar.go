package tdf

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// ScalarMarshaler lets a type render itself to a single TDF value (the right
// side of key=value). Implement it together with ScalarUnmarshaler on a type to
// have the codec treat it as a scalar field instead of a nested [section].
type ScalarMarshaler interface {
	MarshalTDF() (string, error)
}

// ScalarUnmarshaler lets a type parse itself from a single TDF value.
type ScalarUnmarshaler interface {
	UnmarshalTDF(string) error
}

var (
	scalarMarshalerType   = reflect.TypeOf((*ScalarMarshaler)(nil)).Elem()
	scalarUnmarshalerType = reflect.TypeOf((*ScalarUnmarshaler)(nil)).Elem()
)

// isCustomScalar reports whether t (or a pointer to t) implements the custom
// scalar codec interfaces, so a field of that type is encoded as one value
// rather than a nested section.
func isCustomScalar(t reflect.Type) bool {
	pt := reflect.PointerTo(t)
	return t.Implements(scalarMarshalerType) || t.Implements(scalarUnmarshalerType) ||
		pt.Implements(scalarMarshalerType) || pt.Implements(scalarUnmarshalerType)
}

// setScalar assigns a TDF string value to a scalar (or pointer-to-scalar) field.
// Shorthand floats such as ".6" are accepted because strconv.ParseFloat handles
// a missing leading zero. Integer fields tolerate a float-formatted value by
// truncating, so a mistyped struct field surfaces as a round-trip mismatch
// rather than a hard parse failure. Types implementing ScalarUnmarshaler parse
// themselves.
func setScalar(f reflect.Value, s string) error {
	if f.Kind() != reflect.Pointer && f.CanAddr() {
		if u, ok := f.Addr().Interface().(ScalarUnmarshaler); ok {
			return u.UnmarshalTDF(s)
		}
	}
	switch f.Kind() {
	case reflect.Pointer:
		if f.IsNil() {
			f.Set(reflect.New(f.Type().Elem()))
		}
		if u, ok := f.Interface().(ScalarUnmarshaler); ok {
			return u.UnmarshalTDF(s)
		}
		return setScalar(f.Elem(), s)
	case reflect.String:
		f.SetString(s)
	case reflect.Bool:
		f.SetBool(parseTDFBool(s))
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if s == "" {
			f.SetInt(0)
			return nil
		}
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			f.SetInt(i)
			return nil
		}
		fl, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return fmt.Errorf("invalid integer %q", s)
		}
		f.SetInt(int64(fl))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		if s == "" {
			f.SetUint(0)
			return nil
		}
		if u, err := strconv.ParseUint(s, 10, 64); err == nil {
			f.SetUint(u)
			return nil
		}
		fl, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return fmt.Errorf("invalid unsigned integer %q", s)
		}
		f.SetUint(uint64(fl))
	case reflect.Float32, reflect.Float64:
		if s == "" {
			f.SetFloat(0)
			return nil
		}
		fl, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return fmt.Errorf("invalid float %q", s)
		}
		f.SetFloat(fl)
	default:
		return fmt.Errorf("unsupported scalar kind %s", f.Kind())
	}
	return nil
}

// getScalar renders a scalar field to its TDF string form and reports whether
// the value is the type's zero value (used by omitempty). Types implementing
// ScalarMarshaler render themselves; a non-nil pointer is always treated as
// present so a pointer-to-custom field round-trips even when its value is the
// zero value (e.g. an RGBString of "0 0 0").
func getScalar(f reflect.Value) (string, bool, error) {
	if f.CanInterface() {
		if m, ok := f.Interface().(ScalarMarshaler); ok {
			if f.Kind() == reflect.Pointer && f.IsNil() {
				return "", true, nil
			}
			s, err := m.MarshalTDF()
			zero := f.Kind() != reflect.Pointer && f.IsZero()
			return s, zero, err
		}
	}
	switch f.Kind() {
	case reflect.Pointer:
		if f.IsNil() {
			return "", true, nil
		}
		s, _, err := getScalar(f.Elem())
		return s, false, err
	case reflect.String:
		s := f.String()
		return s, s == "", nil
	case reflect.Bool:
		if f.Bool() {
			return "1", false, nil
		}
		return "0", true, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		i := f.Int()
		return strconv.FormatInt(i, 10), i == 0, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		u := f.Uint()
		return strconv.FormatUint(u, 10), u == 0, nil
	case reflect.Float32:
		v := f.Float()
		return strconv.FormatFloat(v, 'f', -1, 32), v == 0, nil
	case reflect.Float64:
		v := f.Float()
		return strconv.FormatFloat(v, 'f', -1, 64), v == 0, nil
	default:
		return "", true, nil
	}
}

func parseTDFBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	case "", "0", "false", "no", "off":
		return false
	}
	if f, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
		return f != 0
	}
	return false
}

// setScalarList parses a single value into a slice. With an empty delim the
// value is split on runs of whitespace (the default). Otherwise it is split on
// the delimiter's non-space core (so "," and ", " both split "2, 3, 4"), with
// surrounding whitespace trimmed from each element.
func setScalarList(f reflect.Value, value, delim string) error {
	var parts []string
	if core := strings.TrimSpace(delim); core == "" {
		parts = strings.Fields(value)
	} else {
		for _, p := range strings.Split(value, core) {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
	}
	s := reflect.MakeSlice(f.Type(), len(parts), len(parts))
	for i, p := range parts {
		if err := setScalar(s.Index(i), p); err != nil {
			return err
		}
	}
	f.Set(s)
	return nil
}

// encodeScalarList joins a slice's elements with delim (a single space when
// delim is empty), reproducing the on-disk separator.
func encodeScalarList(f reflect.Value, delim string) (string, error) {
	parts := make([]string, f.Len())
	for i := range parts {
		s, _, err := getScalar(f.Index(i))
		if err != nil {
			return "", err
		}
		parts[i] = s
	}
	join := " "
	if delim != "" {
		join = delim
	}
	return strings.Join(parts, join), nil
}
