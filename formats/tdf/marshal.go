package tdf

import (
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// Marshal renders v as TDF text. v must be a struct, a slice of structs, or a
// pointer to either. A slice produces one top-level [section] per element
// (named by its `tdf:",name"` field); a struct produces its tagged fields and
// nested sections at the top level. The inverse of Unmarshal.
func Marshal(v any) ([]byte, error) {
	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, fmt.Errorf("tdf: Marshal of nil %T", v)
		}
		rv = rv.Elem()
	}

	var els []*element
	switch rv.Kind() {
	case reflect.Slice:
		for i := 0; i < rv.Len(); i++ {
			el, err := encodeElement(rv.Index(i))
			if err != nil {
				return nil, err
			}
			els = append(els, el)
		}
	case reflect.Struct:
		children, err := encodeStruct(rv)
		if err != nil {
			return nil, err
		}
		els = children
	default:
		return nil, fmt.Errorf("tdf: Marshal requires a struct or slice, got %s", rv.Kind())
	}

	var b strings.Builder
	writeElements(&b, els, 0)
	return []byte(b.String()), nil
}

// encodeElement turns a struct value into a named [section] element.
func encodeElement(rv reflect.Value) (*element, error) {
	for rv.Kind() == reflect.Pointer {
		rv = rv.Elem()
	}
	spec := specFor(rv.Type())
	name := ""
	if spec.nameIndex != nil {
		name = rv.FieldByIndex(spec.nameIndex).String()
	}
	children, err := encodeStruct(rv)
	if err != nil {
		return nil, err
	}
	return &element{key: name, section: true, children: children}, nil
}

// encodeStruct renders a struct's tagged fields to an ordered element list.
func encodeStruct(rv reflect.Value) ([]*element, error) {
	spec := specFor(rv.Type())
	var out []*element

	for _, fs := range spec.fields {
		if fs.isName || fs.isRemaining || fs.isSections {
			continue
		}
		f := rv.FieldByIndex(fs.index)
		switch categorize(f.Type()) {
		case catScalar:
			s, zero, err := getScalar(f)
			if err != nil {
				return nil, err
			}
			if fs.omitempty && zero {
				continue
			}
			out = append(out, &element{key: fs.key, value: s})
		case catScalarList:
			if fs.omitempty && f.Len() == 0 {
				continue
			}
			v, err := encodeScalarList(f, fs.delimiter)
			if err != nil {
				return nil, err
			}
			out = append(out, &element{key: fs.key, value: v})
		case catSection:
			if f.Kind() == reflect.Pointer && f.IsNil() {
				continue
			}
			sv := f
			if f.Kind() == reflect.Pointer {
				sv = f.Elem()
			}
			children, err := encodeStruct(sv)
			if err != nil {
				return nil, err
			}
			if fs.omitempty && len(children) == 0 {
				continue
			}
			out = append(out, &element{key: fs.key, section: true, children: children})
		case catRepeated:
			// A repeats= field emits a sibling count key (e.g. SCHEMACOUNT=2)
			// ahead of the blocks, matching the on-disk layout.
			if fs.countKey != "" {
				out = append(out, &element{key: fs.countKey, value: strconv.Itoa(f.Len())})
			}
			for i := 0; i < f.Len(); i++ {
				el, err := encodeElement(f.Index(i))
				if err != nil {
					return nil, err
				}
				if el.key == "" {
					el.key = fmt.Sprintf("%s%d", fs.key, i)
				}
				out = append(out, el)
			}
		case catMap:
			children, err := encodeMap(f)
			if err != nil {
				return nil, err
			}
			if fs.omitempty && len(children) == 0 {
				continue
			}
			out = append(out, &element{key: fs.key, section: true, children: children})
		}
	}

	if spec.sectionsIndex != nil {
		f := rv.FieldByIndex(spec.sectionsIndex)
		for i := 0; i < f.Len(); i++ {
			el, err := encodeElement(f.Index(i))
			if err != nil {
				return nil, err
			}
			out = append(out, el)
		}
	}

	if spec.remainingIndex != nil {
		out = append(out, encodeRemaining(rv.FieldByIndex(spec.remainingIndex))...)
	}
	return out, nil
}

func encodeMap(f reflect.Value) ([]*element, error) {
	keys := f.MapKeys()
	sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
	out := make([]*element, 0, len(keys))
	for _, k := range keys {
		s, _, err := getScalar(f.MapIndex(k))
		if err != nil {
			return nil, err
		}
		out = append(out, &element{key: k.String(), value: s})
	}
	return out, nil
}

func encodeRemaining(f reflect.Value) []*element {
	if f.IsNil() {
		return nil
	}
	keys := f.MapKeys()
	sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
	out := make([]*element, 0, len(keys))
	for _, k := range keys {
		out = append(out, &element{key: k.String(), value: f.MapIndex(k).String()})
	}
	return out
}
