// Package tdf implements reading and writing of Total Annihilation TDF/FBI files.
//
// TDF (Text Data File) and FBI (Feature/Building/Item) files share the same format:
// - Section-based structure with [SECTION_NAME] headers
// - Key-value pairs in format: key=value;
// - Values enclosed in braces { }
// - Case-insensitive keys
// - Support for string, numeric, and list values
//
// Example usage:
//
//	// Reading
//	doc, err := tdf.ParseFile("units/ARMCOM.FBI")
//	section := doc.Section("UNITINFO")
//	name := section.String("UnitName")
//	cost := section.Int("BuildCostMetal")
//
//	// Writing
//	doc := tdf.NewDocument()
//	unit := doc.AddSection("UNITINFO")
//	unit.SetString("UnitName", "ARMCOM")
//	unit.SetInt("BuildCostMetal", 2500)
//	doc.WriteFile("output.fbi")
package tdf

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Document represents a complete TDF/FBI file
type Document struct {
	sections    map[string]*Section
	order       []string // Preserve section order
	rootSections []*Section // Top-level sections in order
}

// Section represents a [SECTION] in a TDF file
type Section struct {
	name     string
	fields   map[string]*Field
	order    []string // Preserve field order
	sections []*Section
}

// Field represents a key-value pair in a section
type Field struct {
	key   string
	value string
}

// Key returns the field key
func (f *Field) Key() string {
	return f.key
}

// Value returns the field value
func (f *Field) Value() string {
	return f.value
}

// NewDocument creates a new empty TDF document
func NewDocument() *Document {
	return &Document{
		sections:     make(map[string]*Section),
		order:        make([]string, 0),
		rootSections: make([]*Section, 0),
	}
}

// Parse parses TDF content from a reader
func Parse(r io.Reader) (*Document, error) {
	doc := NewDocument()
	scanner := bufio.NewScanner(r)

	var sectionStack []*Section
	var pendingSection *Section
	lineNum := 0

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}

		// Check for section header [SECTIONNAME]
		if strings.HasPrefix(line, "[") {
			endBracket := strings.Index(line, "]")
			if endBracket > 0 {
				sectionName := strings.TrimSpace(line[1:endBracket])
				pendingSection = &Section{
					name:   sectionName,
					fields: make(map[string]*Field),
					order:  []string{},
				}
				continue
			}
		}

		// Handle inline section: [NAME] { key=val; key=val; }
		// or inline brace block: { key=val; key=val; }
		hasBraceOpen := strings.Contains(line, "{")
		hasBraceClose := strings.Contains(line, "}")

		if hasBraceOpen && hasBraceClose {
			// Inline block — open and close on the same line.
			if pendingSection != nil {
				if len(sectionStack) > 0 {
					parent := sectionStack[len(sectionStack)-1]
					parent.sections = append(parent.sections, pendingSection)
				} else {
					doc.rootSections = append(doc.rootSections, pendingSection)
					doc.sections[strings.ToUpper(pendingSection.name)] = pendingSection
					doc.order = append(doc.order, strings.ToUpper(pendingSection.name))
				}
				// Parse inline key=value pairs between { and }.
				braceStart := strings.Index(line, "{")
				braceEnd := strings.LastIndex(line, "}")
				if braceStart >= 0 && braceEnd > braceStart {
					inner := line[braceStart+1 : braceEnd]
					for _, part := range strings.Split(inner, ";") {
						part = strings.TrimSpace(part)
						if idx := strings.Index(part, "="); idx > 0 {
							key := strings.TrimSpace(part[:idx])
							value := strings.TrimSpace(part[idx+1:])
							pendingSection.Set(key, value)
						}
					}
				}
				pendingSection = nil
			}
			continue
		}

		// Check for opening brace
		if hasBraceOpen {
			if pendingSection != nil {
				if len(sectionStack) > 0 {
					parent := sectionStack[len(sectionStack)-1]
					parent.sections = append(parent.sections, pendingSection)
				} else {
					doc.rootSections = append(doc.rootSections, pendingSection)
					doc.sections[strings.ToUpper(pendingSection.name)] = pendingSection
					doc.order = append(doc.order, strings.ToUpper(pendingSection.name))
				}
				sectionStack = append(sectionStack, pendingSection)
				pendingSection = nil
			}
			continue
		}

		// Check for closing brace
		if hasBraceClose {
			if len(sectionStack) > 0 {
				sectionStack = sectionStack[:len(sectionStack)-1]
			}
			continue
		}

		// Parse key=value pairs inside braces
		if len(sectionStack) > 0 {
			currentSection := sectionStack[len(sectionStack)-1]
			if idx := strings.Index(line, "="); idx > 0 {
				key := strings.TrimSpace(line[:idx])
				value := strings.TrimSpace(line[idx+1:])
				value = strings.TrimSuffix(value, ";")
				currentSection.Set(key, value)
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan error: %w", err)
	}

	return doc, nil
}

// ParseFile parses a TDF file
func ParseFile(path string) (*Document, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()

	return Parse(file)
}

// ParseString parses TDF content from a string
func ParseString(content string) (*Document, error) {
	return Parse(strings.NewReader(content))
}

// Section returns a section by name (case-insensitive)
func (d *Document) Section(name string) *Section {
	name = strings.ToUpper(name)
	return d.sections[name]
}

// Sections returns all sections
func (d *Document) Sections() []*Section {
	return d.rootSections
}

// AddSection adds a new section or returns existing one
func (d *Document) AddSection(name string) *Section {
	upperName := strings.ToUpper(name)
	
	if section, exists := d.sections[upperName]; exists {
		return section
	}

	section := &Section{
		name:   name, // Preserve original case
		fields: make(map[string]*Field),
		order:  make([]string, 0),
	}

	d.sections[upperName] = section
	d.order = append(d.order, upperName)
	
	return section
}

// HasSection checks if a section exists
func (d *Document) HasSection(name string) bool {
	_, exists := d.sections[strings.ToUpper(name)]
	return exists
}

// Write writes the document to a writer
func (d *Document) Write(w io.Writer) error {
	for _, sectionName := range d.order {
		section := d.sections[sectionName]
		
		// Write section header
		if _, err := fmt.Fprintf(w, "[%s]\n", section.name); err != nil {
			return err
		}

		// Write opening brace with indentation
		if _, err := fmt.Fprintf(w, "\t{\n"); err != nil {
			return err
		}

		// Write fields
		for _, fieldKey := range section.order {
			field := section.fields[fieldKey]
			if _, err := fmt.Fprintf(w, "\t%s=%s;\n", field.key, field.value); err != nil {
				return err
			}
		}

		// Write closing brace
		if _, err := fmt.Fprintf(w, "\t}\n"); err != nil {
			return err
		}
	}

	return nil
}

// WriteFile writes the document to a file
func (d *Document) WriteFile(path string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()

	return d.Write(file)
}

// String returns the TDF content as a string
func (d *Document) String() string {
	var sb strings.Builder
	_ = d.Write(&sb)
	return sb.String()
}

// Name returns the section name
func (s *Section) Name() string {
	return s.name
}

// Get returns a field value by key (case-insensitive)
func (s *Section) Get(key string) (string, bool) {
	key = strings.ToUpper(key)
	if field, exists := s.fields[key]; exists {
		return field.value, true
	}
	return "", false
}

// Set sets a field value
func (s *Section) Set(key, value string) {
	upperKey := strings.ToUpper(key)
	
	if field, exists := s.fields[upperKey]; exists {
		field.value = value
		return
	}

	field := &Field{
		key:   key, // Preserve original case
		value: value,
	}

	s.fields[upperKey] = field
	s.order = append(s.order, upperKey)
}

// Has checks if a field exists
func (s *Section) Has(key string) bool {
	_, exists := s.fields[strings.ToUpper(key)]
	return exists
}

// String returns a string value (empty string if not found)
func (s *Section) String(key string) string {
	value, _ := s.Get(key)
	return value
}

// Int returns an integer value (0 if not found or invalid)
func (s *Section) Int(key string) int {
	value, ok := s.Get(key)
	if !ok {
		return 0
	}
	
	i, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	
	return i
}

// Float returns a float value (0.0 if not found or invalid)
func (s *Section) Float(key string) float64 {
	value, ok := s.Get(key)
	if !ok {
		return 0.0
	}
	
	f, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0.0
	}
	
	return f
}

// Bool returns a boolean value (false if not found)
// Accepts: 1/0, true/false, yes/no (case-insensitive)
func (s *Section) Bool(key string) bool {
	value, ok := s.Get(key)
	if !ok {
		return false
	}
	
	value = strings.ToLower(strings.TrimSpace(value))
	
	switch value {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// List returns a value split by spaces (for category lists, etc.)
func (s *Section) List(key string) []string {
	value, ok := s.Get(key)
	if !ok {
		return nil
	}
	
	// Split by spaces and filter empty strings
	parts := strings.Fields(value)
	return parts
}

// SetString sets a string value
func (s *Section) SetString(key, value string) {
	s.Set(key, value)
}

// SetInt sets an integer value
func (s *Section) SetInt(key string, value int) {
	s.Set(key, strconv.Itoa(value))
}

// SetFloat sets a float value
func (s *Section) SetFloat(key string, value float64) {
	s.Set(key, strconv.FormatFloat(value, 'f', -1, 64))
}

// SetBool sets a boolean value (as 1 or 0)
func (s *Section) SetBool(key string, value bool) {
	if value {
		s.Set(key, "1")
	} else {
		s.Set(key, "0")
	}
}

// SetList sets a space-separated list value
func (s *Section) SetList(key string, values []string) {
	s.Set(key, strings.Join(values, " "))
}

// Fields returns all fields in order
func (s *Section) Fields() []*Field {
	fields := make([]*Field, 0, len(s.order))
	for _, key := range s.order {
		fields = append(fields, s.fields[key])
	}
	return fields
}

// Sections returns nested subsections
func (s *Section) Sections() []*Section {
	return s.sections
}
