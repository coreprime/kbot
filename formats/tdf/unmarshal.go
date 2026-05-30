package tdf

import (
	"fmt"
	"reflect"
	"strings"
)

// Unmarshal parses TDF/FBI/GUI bytes into v, which must be a non-nil pointer to
// a struct or to a slice of structs.
//
// When v points to a slice, each top-level [section] becomes one element; a
// field tagged `tdf:",name"` on the element struct receives the section header.
// When v points to a struct, the document's top-level sections and fields are
// matched against that struct's tagged fields.
//
// Field mapping by Go type:
//   - string / numeric / bool (and pointers to them): key=value
//   - []string / []int ...: a single space-separated value
//   - struct / *struct: a nested [name]{ } section
//   - []struct: repeated [name]{ } sections (matched by exact name, or by name
//     prefix when several share a stem like GADGET0, GADGET1)
//   - map[string]scalar: a section whose keys are dynamic (e.g. [DAMAGE])
//   - map[string]string tagged `,remaining`: catch-all for unmatched keys
func Unmarshal(data []byte, v any) error {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return fmt.Errorf("tdf: Unmarshal requires a non-nil pointer, got %T", v)
	}
	els, err := parseDocument(data)
	if err != nil {
		return err
	}
	target := rv.Elem()
	switch target.Kind() {
	case reflect.Slice:
		return decodeSlice(els, target)
	case reflect.Struct:
		return decodeStruct(els, target)
	default:
		return fmt.Errorf("tdf: Unmarshal target must point to a struct or slice, got %s", target.Kind())
	}
}

func decodeSlice(els []*element, target reflect.Value) error {
	for _, el := range els {
		if !el.section {
			continue
		}
		if err := appendRepeated(el, target); err != nil {
			return err
		}
	}
	return nil
}

// decodeStruct fills rv (a struct) from a list of child elements.
func decodeStruct(children []*element, rv reflect.Value) error {
	spec := specFor(rv.Type())

	var remaining reflect.Value
	if spec.remainingIndex != nil {
		remaining = rv.FieldByIndex(spec.remainingIndex)
		if remaining.IsNil() {
			remaining.Set(reflect.MakeMap(remaining.Type()))
		}
	}

	for _, child := range children {
		if child.section {
			if err := decodeSectionChild(child, rv, spec); err != nil {
				return err
			}
			continue
		}
		if err := decodeFieldChild(child, rv, spec, remaining); err != nil {
			return err
		}
	}
	return nil
}

func decodeFieldChild(child *element, rv reflect.Value, spec structSpec, remaining reflect.Value) error {
	if fs, ok := spec.fieldByName(child.key); ok {
		f := rv.FieldByIndex(fs.index)
		switch categorize(f.Type()) {
		case catScalar:
			if err := setScalar(f, child.value); err != nil {
				// Dirty game data: a value that does not fit its declared
				// type (a typo like "13O", or a field that ran past a missing
				// ';'). Preserve it verbatim in the catch-all so the file still
				// round-trips, rather than failing the whole document.
				if remaining.IsValid() {
					remaining.SetMapIndex(reflect.ValueOf(child.key), reflect.ValueOf(child.value))
					return nil
				}
				return fmt.Errorf("tdf: field %s: %w", child.key, err)
			}
			return nil
		case catScalarList:
			return setScalarList(f, child.value, fs.delimiter)
		}
	}
	// A repeats= count key (e.g. SCHEMACOUNT) is derived from the slice length
	// on marshal, so drop it here instead of leaking it into the catch-all,
	// which would otherwise emit it twice.
	if spec.countKeys[strings.ToUpper(child.key)] {
		return nil
	}
	if remaining.IsValid() {
		remaining.SetMapIndex(reflect.ValueOf(child.key), reflect.ValueOf(child.value))
	}
	return nil
}

func decodeSectionChild(child *element, rv reflect.Value, spec structSpec) error {
	u := strings.ToUpper(child.key)

	// Exact-name match for single sections and dynamic-key maps.
	for _, fs := range spec.fields {
		if fs.isName || fs.isRemaining || fs.isSections || fs.ukey != u {
			continue
		}
		f := rv.FieldByIndex(fs.index)
		switch categorize(f.Type()) {
		case catSection:
			return decodeElement(child, sectionTarget(f))
		case catMap:
			return decodeMap(child, f)
		}
	}

	// Prefix match for repeated section slices (e.g. GADGET0..GADGETn). A
	// keyless repeated field is the catch-all (handled below), not a prefix
	// match for every section, so require a non-empty key here.
	for _, fs := range spec.fields {
		if fs.isName || fs.isRemaining || fs.isSections || fs.ukey == "" {
			continue
		}
		f := rv.FieldByIndex(fs.index)
		if categorize(f.Type()) != catRepeated {
			continue
		}
		if strings.HasPrefix(u, fs.ukey) {
			return appendRepeated(child, f)
		}
	}
	// Unmatched child section: keep it in the ,sections catch-all so the file
	// round-trips, or drop it if the struct declares no such field.
	if spec.sectionsIndex != nil {
		return appendRepeated(child, rv.FieldByIndex(spec.sectionsIndex))
	}
	return nil
}

// decodeElement sets a struct's name field (if any) and decodes its children.
func decodeElement(el *element, rv reflect.Value) error {
	spec := specFor(rv.Type())
	if spec.nameIndex != nil {
		rv.FieldByIndex(spec.nameIndex).SetString(el.key)
	}
	return decodeStruct(el.children, rv)
}

// sectionTarget returns an addressable struct value for a struct/*struct field.
func sectionTarget(f reflect.Value) reflect.Value {
	if f.Kind() == reflect.Pointer {
		if f.IsNil() {
			f.Set(reflect.New(f.Type().Elem()))
		}
		return f.Elem()
	}
	return f
}

func decodeMap(child *element, f reflect.Value) error {
	if f.IsNil() {
		f.Set(reflect.MakeMap(f.Type()))
	}
	vt := f.Type().Elem()
	for _, c := range child.children {
		if c.section {
			continue
		}
		ev := reflect.New(vt).Elem()
		if err := setScalar(ev, c.value); err != nil {
			return fmt.Errorf("tdf: map %s[%s]: %w", child.key, c.key, err)
		}
		f.SetMapIndex(reflect.ValueOf(c.key), ev)
	}
	return nil
}

func appendRepeated(child *element, f reflect.Value) error {
	et := f.Type().Elem()
	if et.Kind() == reflect.Pointer {
		ev := reflect.New(et.Elem())
		if err := decodeElement(child, ev.Elem()); err != nil {
			return err
		}
		f.Set(reflect.Append(f, ev))
		return nil
	}
	ev := reflect.New(et)
	if err := decodeElement(child, ev.Elem()); err != nil {
		return err
	}
	f.Set(reflect.Append(f, ev.Elem()))
	return nil
}
