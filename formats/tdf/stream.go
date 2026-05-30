package tdf

import (
	"bufio"
	"fmt"
	"io"
	"reflect"
	"strings"
)

// Encoder writes TDF documents straight to an io.Writer. Unlike Marshal, which
// builds the whole document in memory before returning bytes, a slice target is
// emitted one top-level [section] at a time, so peak memory is bounded by the
// largest single section rather than the full document.
type Encoder struct {
	w *bufio.Writer
}

// NewEncoder returns an Encoder that writes to w.
func NewEncoder(w io.Writer) *Encoder {
	return &Encoder{w: bufio.NewWriter(w)}
}

// Encode renders v as TDF text to the underlying writer and flushes. v must be
// a struct, a slice of structs, or a pointer to either, exactly as for Marshal.
func (e *Encoder) Encode(v any) error {
	rv := reflect.ValueOf(v)
	for rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return fmt.Errorf("tdf: Encode of nil %T", v)
		}
		rv = rv.Elem()
	}

	switch rv.Kind() {
	case reflect.Slice:
		for i := 0; i < rv.Len(); i++ {
			el, err := encodeElement(rv.Index(i))
			if err != nil {
				return err
			}
			if err := writeElems(e.w, []*element{el}, 0); err != nil {
				return err
			}
		}
	case reflect.Struct:
		children, err := encodeStruct(rv)
		if err != nil {
			return err
		}
		if err := writeElems(e.w, children, 0); err != nil {
			return err
		}
	default:
		return fmt.Errorf("tdf: Encode requires a struct or slice, got %s", rv.Kind())
	}
	return e.w.Flush()
}

// Decoder reads a TDF document from an io.Reader. A slice target is filled one
// top-level [section] at a time as the reader is consumed, so the whole input
// never has to be buffered into a single string the way Unmarshal does.
type Decoder struct {
	p *streamParser
}

// NewDecoder returns a Decoder that reads from r.
func NewDecoder(r io.Reader) *Decoder {
	br, ok := r.(*bufio.Reader)
	if !ok {
		br = bufio.NewReader(r)
	}
	return &Decoder{p: &streamParser{r: &stripReader{r: br}}}
}

// Decode parses the document into v, which must be a non-nil pointer to a struct
// or to a slice of structs, exactly as for Unmarshal. A struct target gathers
// every top-level element before decoding (fields may appear in any order); a
// slice target decodes each section as it is read.
func (d *Decoder) Decode(v any) error {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return fmt.Errorf("tdf: Decode requires a non-nil pointer, got %T", v)
	}
	target := rv.Elem()
	switch target.Kind() {
	case reflect.Slice:
		for {
			el, err := d.p.nextTopElement()
			if err != nil {
				return err
			}
			if el == nil {
				return nil
			}
			if !el.section {
				continue
			}
			if err := appendRepeated(el, target); err != nil {
				return err
			}
		}
	case reflect.Struct:
		var els []*element
		for {
			el, err := d.p.nextTopElement()
			if err != nil {
				return err
			}
			if el == nil {
				break
			}
			els = append(els, el)
		}
		return decodeStruct(els, target)
	default:
		return fmt.Errorf("tdf: Decode target must point to a struct or slice, got %s", target.Kind())
	}
}

// stripReader presents a comment-free byte stream over a bufio.Reader, mirroring
// stripComments: // line comments run to (but keep) the newline, and /* */ block
// comments collapse to a single space so neighbouring tokens stay separated. A
// lone '/' not starting a comment is preserved.
type stripReader struct {
	r *bufio.Reader
}

func (s *stripReader) ReadByte() (byte, error) {
	b, err := s.r.ReadByte()
	if err != nil || b != '/' {
		return b, err
	}
	nb, err := s.r.ReadByte()
	if err != nil {
		// Trailing '/' at EOF: emit it; the next read surfaces the EOF.
		return '/', nil
	}
	switch nb {
	case '/':
		for {
			c, err := s.r.ReadByte()
			if err != nil {
				return 0, err
			}
			if c == '\n' {
				return '\n', nil
			}
		}
	case '*':
		for {
			c, err := s.r.ReadByte()
			if err != nil {
				return ' ', nil // unterminated block comment closes at EOF
			}
			if c == '*' {
				c2, err := s.r.ReadByte()
				if err != nil {
					return ' ', nil
				}
				if c2 == '/' {
					return ' ', nil
				}
				_ = s.r.UnreadByte() // re-examine c2 (may be another '*')
			}
		}
	default:
		_ = s.r.UnreadByte() // nb is ordinary input; put it back
		return '/', nil
	}
}

// streamParser is a single-byte-lookahead recursive-descent parser over a
// stripReader. It mirrors the in-memory parser in codec.go exactly, but pulls
// bytes on demand instead of indexing a materialised string.
type streamParser struct {
	r      *stripReader
	cur    byte
	hasCur bool
	done   bool
	err    error
}

// peek returns the next byte without consuming it. ok is false at EOF or after
// an I/O error (which is recorded in p.err).
func (p *streamParser) peek() (b byte, ok bool) {
	if p.hasCur {
		return p.cur, true
	}
	if p.done {
		return 0, false
	}
	c, err := p.r.ReadByte()
	if err != nil {
		p.done = true
		if err != io.EOF {
			p.err = err
		}
		return 0, false
	}
	p.cur = c
	p.hasCur = true
	return c, true
}

func (p *streamParser) advance() { p.hasCur = false }

func (p *streamParser) skipSpace() {
	for {
		b, ok := p.peek()
		if !ok {
			return
		}
		switch b {
		case ' ', '\t', '\r', '\n', '\f', '\v':
			p.advance()
		default:
			return
		}
	}
}

// nextTopElement returns the next top-level element, or (nil, nil) at clean EOF.
// Stray braces and empty statements are skipped, matching parseBody(top=true).
func (p *streamParser) nextTopElement() (*element, error) {
	for {
		p.skipSpace()
		b, ok := p.peek()
		if !ok {
			return nil, p.err
		}
		switch b {
		case '}', '{', ';':
			p.advance()
		case '[':
			return p.parseSection()
		default:
			el, ok, err := p.parseField()
			if err != nil {
				return nil, err
			}
			if ok {
				return el, nil
			}
		}
	}
}

// parseBody reads elements until a closing '}' or EOF (a missing brace at EOF
// auto-closes, matching the lenient in-memory parser).
func (p *streamParser) parseBody() ([]*element, error) {
	var out []*element
	for {
		p.skipSpace()
		b, ok := p.peek()
		if !ok {
			return out, p.err
		}
		switch b {
		case '}':
			p.advance()
			return out, nil
		case '{', ';':
			p.advance()
		case '[':
			el, err := p.parseSection()
			if err != nil {
				return nil, err
			}
			out = append(out, el)
		default:
			el, ok, err := p.parseField()
			if err != nil {
				return nil, err
			}
			if ok {
				out = append(out, el)
			}
		}
	}
}

func (p *streamParser) parseSection() (*element, error) {
	p.advance() // consume '['
	var name strings.Builder
	for {
		b, ok := p.peek()
		if !ok {
			if p.err != nil {
				return nil, p.err
			}
			return nil, fmt.Errorf("tdf: unterminated section header")
		}
		p.advance()
		if b == ']' {
			break
		}
		name.WriteByte(b)
	}
	key := strings.TrimSpace(name.String())
	p.skipSpace()
	if b, ok := p.peek(); !ok || b != '{' {
		return &element{key: key, section: true}, nil
	}
	p.advance() // consume '{'
	children, err := p.parseBody()
	if err != nil {
		return nil, err
	}
	return &element{key: key, section: true, children: children}, nil
}

// parseField reads "key = value;". The value runs to the next ';' or '}', so it
// may contain spaces and '=' characters. A token with no '=' before a terminator
// is discarded (ok=false); the leading terminator is consumed only when no key
// bytes were read, to guarantee forward progress.
func (p *streamParser) parseField() (*element, bool, error) {
	var key strings.Builder
	for {
		b, ok := p.peek()
		if !ok {
			return nil, false, p.err
		}
		switch b {
		case '=':
			p.advance()
			var val strings.Builder
			for {
				c, ok := p.peek()
				if !ok {
					if p.err != nil {
						return nil, false, p.err
					}
					break // value runs to EOF
				}
				if c == ';' || c == '}' {
					break
				}
				p.advance()
				val.WriteByte(c)
			}
			if c, ok := p.peek(); ok && c == ';' {
				p.advance()
			}
			return &element{
				key:   strings.TrimSpace(key.String()),
				value: strings.TrimSpace(val.String()),
			}, true, nil
		case ';', '}', '{', '[':
			if key.Len() == 0 {
				p.advance()
			}
			return nil, false, nil
		default:
			p.advance()
			key.WriteByte(b)
		}
	}
}
