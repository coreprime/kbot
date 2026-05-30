package tsf

import (
	"fmt"
	"strings"
)

// Document is a parsed TSF text file: an optional block of leading trivia
// (comments and blank lines), one or more top-level sections, and any trailing
// trivia. Re-serializing a parsed Document reproduces the original bytes.
type Document struct {
	// Leading holds verbatim lines that appear before the first section
	// (typically a comment and a blank line).
	Leading []string
	// Sections holds the top-level sections in order.
	Sections []*Section
	// Trailing holds verbatim lines that appear after the last section.
	Trailing []string
	// LineEnding is the terminator used between lines ("\r\n" or "\n").
	LineEnding string
}

// Section is a named brace-delimited block. Its body is an ordered list of
// assignments and nested sections.
type Section struct {
	Name string
	Body []Node
}

// Node is one element of a section body: either an *Assignment or a *Section.
type Node interface{ isNode() }

// Assignment is a "Key = Value;" statement.
type Assignment struct {
	Key   string
	Value string
}

func (*Assignment) isNode() {}
func (*Section) isNode()    {}

// Get returns the value of the first assignment with the given key and whether
// it was found. Section nodes are ignored.
func (s *Section) Get(key string) (string, bool) {
	for _, n := range s.Body {
		if a, ok := n.(*Assignment); ok && a.Key == key {
			return a.Value, true
		}
	}
	return "", false
}

// Subsections returns the nested sections of s in order.
func (s *Section) Subsections() []*Section {
	var out []*Section
	for _, n := range s.Body {
		if sub, ok := n.(*Section); ok {
			out = append(out, sub)
		}
	}
	return out
}

// ParseTSF parses TSF text into a Document.
func ParseTSF(text string) (*Document, error) {
	ending := "\n"
	if strings.Contains(text, "\r\n") {
		ending = "\r\n"
	}
	lines := strings.Split(text, ending)

	doc := &Document{LineEnding: ending}

	// Leading trivia: every line up to the first section header.
	i := 0
	for i < len(lines) && !isSectionHeader(lines[i]) {
		doc.Leading = append(doc.Leading, lines[i])
		i++
	}

	// Top-level sections.
	for i < len(lines) && isSectionHeader(lines[i]) {
		sec, next, err := parseSection(lines, i)
		if err != nil {
			return nil, err
		}
		doc.Sections = append(doc.Sections, sec)
		i = next
	}

	// Anything left over is trailing trivia.
	for ; i < len(lines); i++ {
		doc.Trailing = append(doc.Trailing, lines[i])
	}

	if len(doc.Sections) == 0 {
		return nil, fmt.Errorf("tsf: no sections found")
	}
	return doc, nil
}

// parseSection parses the section starting at lines[start]. It returns the
// section and the index of the first line after the closing brace.
func parseSection(lines []string, start int) (*Section, int, error) {
	header := strings.TrimSpace(lines[start])
	name := strings.TrimSuffix(strings.TrimPrefix(header, "["), "]")
	sec := &Section{Name: name}

	i := start + 1
	if i >= len(lines) || strings.TrimSpace(lines[i]) != "{" {
		return nil, 0, fmt.Errorf("tsf: expected '{' after section [%s]", name)
	}
	i++

	for i < len(lines) {
		trimmed := strings.TrimSpace(lines[i])
		switch {
		case trimmed == "}":
			return sec, i + 1, nil
		case isSectionHeader(lines[i]):
			sub, next, err := parseSection(lines, i)
			if err != nil {
				return nil, 0, err
			}
			sec.Body = append(sec.Body, sub)
			i = next
		case trimmed == "":
			// Blank line inside a section body: skip it. Retail TSF bodies
			// contain no blank lines, so this only guards malformed input.
			i++
		default:
			a, err := parseAssignment(trimmed)
			if err != nil {
				return nil, 0, fmt.Errorf("tsf: section [%s]: %w", name, err)
			}
			sec.Body = append(sec.Body, a)
			i++
		}
	}
	return nil, 0, fmt.Errorf("tsf: unterminated section [%s]", name)
}

func parseAssignment(s string) (*Assignment, error) {
	eq := strings.IndexByte(s, '=')
	if eq < 0 {
		return nil, fmt.Errorf("malformed statement %q", s)
	}
	key := strings.TrimSpace(s[:eq])
	value := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s[eq+1:]), ";"))
	if key == "" {
		return nil, fmt.Errorf("empty key in %q", s)
	}
	return &Assignment{Key: key, Value: value}, nil
}

func isSectionHeader(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") && len(t) > 2
}

// String renders the document back to text. For a Document produced by
// ParseTSF the output is byte-identical to the input.
func (d *Document) String() string {
	ending := d.LineEnding
	if ending == "" {
		ending = "\r\n"
	}
	var lines []string
	lines = append(lines, d.Leading...)
	for _, sec := range d.Sections {
		lines = appendSection(lines, sec, 0)
	}
	lines = append(lines, d.Trailing...)
	return strings.Join(lines, ending)
}

func appendSection(lines []string, sec *Section, depth int) []string {
	indent := strings.Repeat("\t", depth)
	lines = append(lines, indent+"["+sec.Name+"]")
	lines = append(lines, indent+"{")
	childIndent := strings.Repeat("\t", depth+1)
	for _, n := range sec.Body {
		switch node := n.(type) {
		case *Assignment:
			lines = append(lines, childIndent+node.Key+" = "+node.Value+";")
		case *Section:
			lines = appendSection(lines, node, depth+1)
		}
	}
	lines = append(lines, indent+"}")
	return lines
}
