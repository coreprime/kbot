package parser

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/coreprime/kbot/filesystem"
)

// Preprocessor handles BOS file preprocessing (#include, #define, #ifdef, etc.)
type Preprocessor struct {
	defines       map[string]string
	includePaths  []string
	processed     map[string]bool // Track processed files to avoid circular includes
	conditionals  []bool          // Stack for #ifdef/#ifndef state
	fs            filesystem.FileSystem
}

// NewPreprocessor creates a new preprocessor with a filesystem
func NewPreprocessor(fs filesystem.FileSystem, includePaths ...string) *Preprocessor {
	defines := map[string]string{
		"TRUE":  "1",
		"FALSE": "0",
	}
	return &Preprocessor{
		defines:      defines,
		includePaths: includePaths,
		processed:    make(map[string]bool),
		conditionals: []bool{true},
		fs:           fs,
	}
}

// Process processes a BOS file and returns the expanded source
func (p *Preprocessor) Process(path string) (string, error) {
	content, err := p.fs.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("failed to read %s: %w", path, err)
	}

	// Get directory for relative includes
	dir := filepath.Dir(path)

	return p.ProcessContent(string(content), dir)
}

// ProcessContent preprocesses raw source content (as opposed to Process which reads from a file).
func (p *Preprocessor) ProcessContent(content, baseDir string) (string, error) {
	var result strings.Builder
	lines := strings.Split(content, "\n")

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Handle preprocessor directives
		if strings.HasPrefix(trimmed, "#") {
			if err := p.handleDirective(trimmed, baseDir, &result); err != nil {
				return "", fmt.Errorf("line %d: %w", i+1, err)
			}
			continue
		}

		// Only output if we're in an active conditional block
		if p.isActive() {
			// Expand defines in the line
			expanded := p.expandDefines(line)
			result.WriteString(expanded)
			result.WriteString("\n")
		}
	}

	return result.String(), nil
}

// handleDirective processes a preprocessor directive
func (p *Preprocessor) handleDirective(line, baseDir string, result *strings.Builder) error {
	// Extract directive and arguments
	parts := strings.Fields(line)
	if len(parts) == 0 {
		return nil
	}

	directive := parts[0]

	switch directive {
	case "#include":
		return p.handleInclude(parts, baseDir, result)
	case "#define":
		return p.handleDefine(parts)
	case "#undef":
		return p.handleUndef(parts)
	case "#ifdef":
		return p.handleIfdef(parts)
	case "#ifndef":
		return p.handleIfndef(parts)
	case "#if":
		return p.handleIf(line)
	case "#else":
		return p.handleElse()
	case "#endif":
		return p.handleEndif()
	default:
		// Unknown directive - ignore or could error
		return nil
	}
}

// handleInclude processes #include directive
func (p *Preprocessor) handleInclude(parts []string, baseDir string, result *strings.Builder) error {
	if !p.isActive() {
		return nil
	}

	if len(parts) < 2 {
		return fmt.Errorf("invalid #include directive")
	}

	// Extract filename (remove quotes)
	filename := strings.Trim(strings.Join(parts[1:], " "), "\"")

	// Try to find the file
	var includePath string
	
	// First try relative to current file
	candidate := filepath.Join(baseDir, filename)
	if p.fs.Exists(candidate) {
		includePath = candidate
	} else {
		// Try include paths
		for _, dir := range p.includePaths {
			candidate = filepath.Join(dir, filename)
			if p.fs.Exists(candidate) {
				includePath = candidate
				break
			}
		}
	}

	if includePath == "" {
		return fmt.Errorf("include file not found: %s", filename)
	}

	// Avoid circular includes
	if p.processed[includePath] {
		return nil
	}
	p.processed[includePath] = true

	// Process the included file
	content, err := p.fs.ReadFile(includePath)
	if err != nil {
		return fmt.Errorf("failed to read include %s: %w", filename, err)
	}

	includeDir := filepath.Dir(includePath)
	expanded, err := p.ProcessContent(string(content), includeDir)
	if err != nil {
		return fmt.Errorf("in include %s: %w", filename, err)
	}

	result.WriteString(expanded)
	return nil
}

// handleDefine processes #define directive
func (p *Preprocessor) handleDefine(parts []string) error {
	if !p.isActive() {
		return nil
	}

	if len(parts) < 2 {
		return fmt.Errorf("invalid #define directive")
	}

	name := parts[1]
	value := ""
	if len(parts) > 2 {
		value = strings.Join(parts[2:], " ")
	}

	p.defines[name] = value
	return nil
}

// handleUndef processes #undef directive
func (p *Preprocessor) handleUndef(parts []string) error {
	if !p.isActive() {
		return nil
	}

	if len(parts) < 2 {
		return fmt.Errorf("invalid #undef directive")
	}

	delete(p.defines, parts[1])
	return nil
}

// handleIfdef processes #ifdef directive
func (p *Preprocessor) handleIfdef(parts []string) error {
	if len(parts) < 2 {
		return fmt.Errorf("invalid #ifdef directive")
	}

	active := p.isActive()
	_, defined := p.defines[parts[1]]
	p.conditionals = append(p.conditionals, active && defined)
	return nil
}

// handleIfndef processes #ifndef directive
func (p *Preprocessor) handleIfndef(parts []string) error {
	if len(parts) < 2 {
		return fmt.Errorf("invalid #ifndef directive")
	}

	active := p.isActive()
	_, defined := p.defines[parts[1]]
	p.conditionals = append(p.conditionals, active && !defined)
	return nil
}

// handleIf processes #if directive (simple evaluation)
func (p *Preprocessor) handleIf(line string) error {
	// Simple evaluator for common patterns like "#if NUM_SMOKE_PIECES == 1"
	// Extract expression after #if
	expr := strings.TrimSpace(strings.TrimPrefix(line, "#if"))
	
	active := p.isActive()
	result := active && p.evaluateExpression(expr)
	p.conditionals = append(p.conditionals, result)
	return nil
}

// evaluateExpression evaluates simple preprocessor expressions
func (p *Preprocessor) evaluateExpression(expr string) bool {
	// Expand defines first
	expanded := p.expandDefines(expr)
	
	// Handle common comparisons: ==, !=, >, <, >=, <=
	for _, op := range []string{"==", "!=", ">=", "<=", ">", "<"} {
		if strings.Contains(expanded, op) {
			parts := strings.Split(expanded, op)
			if len(parts) == 2 {
				left := strings.TrimSpace(parts[0])
				right := strings.TrimSpace(parts[1])
				return p.compareValues(left, right, op)
			}
		}
	}
	
	// Just a symbol - check if defined and non-zero
	expanded = strings.TrimSpace(expanded)
	if val, exists := p.defines[expanded]; exists {
		return val != "0" && val != ""
	}
	
	// Try to parse as number
	return expanded != "0" && expanded != ""
}

// compareValues compares two values with an operator
func (p *Preprocessor) compareValues(left, right, op string) bool {
	// Try to parse as integers
	var leftVal, rightVal int
	_, err1 := fmt.Sscanf(left, "%d", &leftVal)
	_, err2 := fmt.Sscanf(right, "%d", &rightVal)
	
	if err1 == nil && err2 == nil {
		switch op {
		case "==":
			return leftVal == rightVal
		case "!=":
			return leftVal != rightVal
		case ">":
			return leftVal > rightVal
		case "<":
			return leftVal < rightVal
		case ">=":
			return leftVal >= rightVal
		case "<=":
			return leftVal <= rightVal
		}
	}
	
	// String comparison
	switch op {
	case "==":
		return left == right
	case "!=":
		return left != right
	}
	
	return false
}

// handleElse processes #else directive
func (p *Preprocessor) handleElse() error {
	if len(p.conditionals) <= 1 {
		return fmt.Errorf("#else without matching #ifdef/#ifndef")
	}

	// Flip the current conditional
	idx := len(p.conditionals) - 1
	parent := true
	if idx > 0 {
		parent = p.conditionals[idx-1]
	}
	p.conditionals[idx] = parent && !p.conditionals[idx]
	return nil
}

// handleEndif processes #endif directive
func (p *Preprocessor) handleEndif() error {
	if len(p.conditionals) <= 1 {
		return fmt.Errorf("#endif without matching #ifdef/#ifndef")
	}

	p.conditionals = p.conditionals[:len(p.conditionals)-1]
	return nil
}

// isActive returns true if the current block is active
func (p *Preprocessor) isActive() bool {
	return p.conditionals[len(p.conditionals)-1]
}

// expandDefines expands all #define macros in a line
func (p *Preprocessor) expandDefines(line string) string {
	result := line
	
	// Sort defines by length (longest first) to handle overlapping names
	var names []string
	for name := range p.defines {
		names = append(names, name)
	}
	
	// Simple word boundary replacement
	for _, name := range names {
		value := p.defines[name]
		// Match whole words only (not part of identifiers)
		re := regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\b`)
		result = re.ReplaceAllString(result, value)
	}
	
	return result
}
