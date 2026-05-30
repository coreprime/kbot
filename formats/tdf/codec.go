package tdf

import (
	"fmt"
	"strconv"
	"strings"
)

// element is the parsed representation of a single statement in a TDF file:
// either a key=value field or a [name]{ ... } section containing more elements.
//
// It deliberately preserves field/section ordering and duplicate sibling names
// so that documents can be re-emitted without losing structure.
type element struct {
	key      string     // field key, or section header name
	value    string     // raw, trimmed field value (sections leave this empty)
	section  bool       // true when this is a [name]{ ... } block
	children []*element // child elements for sections
}

// parser walks a comment-stripped TDF source string.
type parser struct {
	src string
	pos int
}

// parseDocument parses raw TDF bytes into the top-level element list.
func parseDocument(data []byte) ([]*element, error) {
	p := &parser{src: stripComments(string(data))}
	return p.parseBody(true)
}

// stripComments removes // line comments and /* */ block comments. TDF has no
// string-quoting, and no game value contains "//" or "/*", so a single global
// pass is safe. Block comments collapse to a single space to avoid gluing
// neighbouring tokens together.
func stripComments(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i, n := 0, len(s); i < n; {
		if s[i] == '/' && i+1 < n && s[i+1] == '/' {
			j := i + 2
			for j < n && s[j] != '\n' {
				j++
			}
			i = j
			continue
		}
		if s[i] == '/' && i+1 < n && s[i+1] == '*' {
			j := i + 2
			for j+1 < n && (s[j] != '*' || s[j+1] != '/') {
				j++
			}
			if j+1 < n {
				j += 2
			} else {
				j = n
			}
			b.WriteByte(' ')
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

func (p *parser) skipSpace() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\r', '\n', '\f', '\v':
			p.pos++
		default:
			return
		}
	}
}

// parseBody reads elements until a closing brace (when top is false) or EOF.
func (p *parser) parseBody(top bool) ([]*element, error) {
	var out []*element
	for {
		p.skipSpace()
		if p.pos >= len(p.src) {
			// Lenient: a missing closing '}' at EOF auto-closes open sections
			// rather than failing, so slightly truncated files still parse.
			return out, nil
		}
		switch p.src[p.pos] {
		case '}':
			p.pos++
			if top {
				continue // stray brace at top level
			}
			return out, nil
		case '{', ';':
			p.pos++ // stray opening brace or empty statement
		case '[':
			el, err := p.parseSection()
			if err != nil {
				return nil, err
			}
			out = append(out, el)
		default:
			if el, ok := p.parseField(); ok {
				out = append(out, el)
			}
		}
	}
}

func (p *parser) parseSection() (*element, error) {
	p.pos++ // consume '['
	end := strings.IndexByte(p.src[p.pos:], ']')
	if end < 0 {
		return nil, fmt.Errorf("tdf: unterminated section header")
	}
	name := strings.TrimSpace(p.src[p.pos : p.pos+end])
	p.pos += end + 1
	p.skipSpace()
	if p.pos >= len(p.src) || p.src[p.pos] != '{' {
		return &element{key: name, section: true}, nil
	}
	p.pos++ // consume '{'
	children, err := p.parseBody(false)
	if err != nil {
		return nil, err
	}
	return &element{key: name, section: true, children: children}, nil
}

// parseField reads "key = value;". The value runs to the next ';' or '}', so it
// may contain spaces and '=' characters (e.g. yardmaps). A token with no '='
// before a terminator is discarded.
func (p *parser) parseField() (*element, bool) {
	start := p.pos
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case '=':
			key := strings.TrimSpace(p.src[start:p.pos])
			p.pos++ // consume '='
			vstart := p.pos
			for p.pos < len(p.src) && p.src[p.pos] != ';' && p.src[p.pos] != '}' {
				p.pos++
			}
			value := strings.TrimSpace(p.src[vstart:p.pos])
			if p.pos < len(p.src) && p.src[p.pos] == ';' {
				p.pos++
			}
			return &element{key: key, value: value}, true
		case ';', '}', '{', '[':
			if p.pos == start {
				p.pos++
			}
			return nil, false
		default:
			p.pos++
		}
	}
	return nil, false
}

// tokenWriter is the subset of writer behaviour the TDF emitter needs. Both
// *strings.Builder (in-memory Marshal/Canonicalize) and *bufio.Writer (the
// streaming Encoder) satisfy it.
type tokenWriter interface {
	WriteString(string) (int, error)
	WriteByte(byte) error
}

// errWriter accumulates the first write error so the emitter can stay
// branch-free; callers check err once at the end.
type errWriter struct {
	w   tokenWriter
	err error
}

func (e *errWriter) str(s string) {
	if e.err == nil {
		_, e.err = e.w.WriteString(s)
	}
}

func (e *errWriter) ch(c byte) {
	if e.err == nil {
		e.err = e.w.WriteByte(c)
	}
}

// writeElems renders elements back to TDF text with tab indentation.
func writeElems(w tokenWriter, els []*element, depth int) error {
	e := &errWriter{w: w}
	for _, el := range els {
		e.writeElem(el, depth)
	}
	return e.err
}

func (e *errWriter) writeElem(el *element, depth int) {
	pad := strings.Repeat("\t", depth)
	if el.section {
		e.str(pad)
		e.ch('[')
		e.str(el.key)
		e.str("]\n")
		e.str(pad)
		e.str("{\n")
		for _, c := range el.children {
			e.writeElem(c, depth+1)
		}
		e.str(pad)
		e.str("}\n")
		return
	}
	e.str(pad)
	e.str(el.key)
	e.ch('=')
	e.str(el.value)
	e.str(";\n")
}

// Canonicalize parses TDF bytes and re-emits them with normalised whitespace and
// comments stripped, preserving every section and field value verbatim. Running
// it twice is idempotent, which makes it a useful lossless round-trip check.
func Canonicalize(data []byte) ([]byte, error) {
	els, err := parseDocument(data)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	if err := writeElems(&b, els, 0); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

// SemanticEqual reports whether two TDF documents are equivalent ignoring
// comments, whitespace, key/section-name case, field ordering, and numeric
// formatting (".6" == "0.60" == "0.6"). A field that is absent on one side is
// treated as equal to a zero-valued field on the other (a missing numeric or
// string key defaults to zero/empty in the engine), which lets `omitempty`
// struct fields round-trip semantically. When the documents differ, the second
// return value describes the first mismatch found.
func SemanticEqual(a, b []byte) (bool, string) {
	ea, err := parseDocument(a)
	if err != nil {
		return false, "parse a: " + err.Error()
	}
	eb, err := parseDocument(b)
	if err != nil {
		return false, "parse b: " + err.Error()
	}
	return elementsEqual(ea, eb, "")
}

func elementsEqual(a, b []*element, path string) (bool, string) {
	fieldsA, sectionsA := group(a)
	fieldsB, sectionsB := group(b)

	for k, va := range fieldsA {
		vb, ok := fieldsB[k]
		if !ok {
			if fieldListZeroish(va) {
				continue
			}
			return false, fmt.Sprintf("%s.%s present only in a (%v)", path, k, va)
		}
		if ok, msg := fieldListEqual(va, vb, path+"."+k); !ok {
			return false, msg
		}
	}
	for k, vb := range fieldsB {
		if _, ok := fieldsA[k]; ok {
			continue
		}
		if !fieldListZeroish(vb) {
			return false, fmt.Sprintf("%s.%s present only in b (%v)", path, k, vb)
		}
	}

	for k, sa := range sectionsA {
		sb := sectionsB[k]
		if ok, msg := sectionListEqual(sa, sb, path+"/"+k); !ok {
			return false, msg
		}
	}
	for k, sb := range sectionsB {
		if _, ok := sectionsA[k]; ok {
			continue
		}
		if ok, msg := sectionListEqual(nil, sb, path+"/"+k); !ok {
			return false, msg
		}
	}
	return true, ""
}

func group(els []*element) (fields map[string][]string, sections map[string][]*element) {
	fields = map[string][]string{}
	sections = map[string][]*element{}
	for _, el := range els {
		key := strings.ToUpper(el.key)
		if el.section {
			sections[key] = append(sections[key], el)
		} else {
			fields[key] = append(fields[key], el.value)
		}
	}
	return fields, sections
}

func fieldListEqual(a, b []string, path string) (bool, string) {
	// TDF field assignment is last-wins: when a key is repeated within a
	// section the engine keeps only the final value, so a typed struct that
	// collapses duplicates to one field is semantically equivalent to the
	// original. Compare the effective (last) value on each side.
	la, lb := a[len(a)-1], b[len(b)-1]
	if !valueEqual(la, lb) {
		return false, fmt.Sprintf("%s: %q vs %q", path, la, lb)
	}
	return true, ""
}

func sectionListEqual(a, b []*element, path string) (bool, string) {
	// A section that exists on only one side is acceptable when it carries no
	// meaningful (non-zero) data.
	if len(a) == 0 || len(b) == 0 {
		extra := a
		if len(a) == 0 {
			extra = b
		}
		for _, el := range extra {
			if !sectionZeroish(el) {
				return false, fmt.Sprintf("%s: section present on only one side with data", path)
			}
		}
		return true, ""
	}
	if len(a) != len(b) {
		return false, fmt.Sprintf("%s: %d vs %d sections", path, len(a), len(b))
	}
	for i := range a {
		if ok, msg := elementsEqual(a[i].children, b[i].children, path); !ok {
			return false, msg
		}
	}
	return true, ""
}

func valueEqual(a, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	// Runs of whitespace between tokens are insignificant in TDF values
	// (e.g. a space-delimited category list "WEAPON  NOTSUB"), so collapse
	// them before comparing.
	if strings.EqualFold(a, b) || strings.EqualFold(collapseSpaces(a), collapseSpaces(b)) {
		return true
	}
	fa, ea := strconv.ParseFloat(a, 64)
	fb, eb := strconv.ParseFloat(b, 64)
	return ea == nil && eb == nil && fa == fb
}

func collapseSpaces(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func valueZeroish(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return true
	}
	f, err := strconv.ParseFloat(v, 64)
	return err == nil && f == 0
}

func fieldListZeroish(vs []string) bool {
	for _, v := range vs {
		if !valueZeroish(v) {
			return false
		}
	}
	return true
}

func sectionZeroish(el *element) bool {
	for _, c := range el.children {
		if c.section {
			if !sectionZeroish(c) {
				return false
			}
		} else if !valueZeroish(c.value) {
			return false
		}
	}
	return true
}
