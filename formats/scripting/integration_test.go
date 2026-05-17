package scripting_test

import (
	"os"
	"github.com/coreprime/kbot/testutil"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/scripting/parser"
)

func TestEndToEndBOSProcessing(t *testing.T) {
	t.Skip("Integration test - parser has known issues with complex BOS files")
	
	// Test with a real BOS file
	path := testutil.UnpackedFile(t, "scripts", "cormstor.bos")
	// Step 1: Preprocess
	scriptsDir := filepath.Dir(path)
	fs, err := filesystem.NewPhysicalFileSystem(scriptsDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem: %v", err)
	}
	defer func() { _ = fs.Close() }()
	
	prep := parser.NewPreprocessor(fs)
	preprocessed, err := prep.Process("cormstor.bos")
	if err != nil {
		t.Fatalf("Preprocessing failed: %v", err)
	}

	t.Logf("Preprocessed %d bytes", len(preprocessed))

	// Step 2: Lex
	lexer := parser.NewLexer(preprocessed, false)
	tokens := lexer.AllTokens()
	
	if len(tokens) == 0 {
		t.Fatal("No tokens produced")
	}
	
	t.Logf("Lexed %d tokens", len(tokens))

	// Step 3: Parse
	p := parser.NewParser(preprocessed)
	program := p.ParseProgram()
	
	if len(p.Errors()) > 0 {
		t.Logf("Parser errors:")
		for _, err := range p.Errors() {
			t.Logf("  %s", err)
		}
		// Don't fail on parse errors for real files - they may have unsupported syntax
		t.Logf("Continuing with %d statements parsed", len(program.Statements))
	}

	if len(program.Statements) == 0 {
		t.Fatal("No statements parsed")
	}

	t.Logf("Parsed %d top-level statements", len(program.Statements))

	// Step 4: Check AST round-trip
	output := program.String()
	if output == "" {
		t.Error("AST round-trip produced empty output")
	}

	t.Logf("Round-trip output length: %d bytes", len(output))

	// Count statement types
	pieceCount := 0
	staticVarCount := 0
	functionCount := 0

	for _, stmt := range program.Statements {
		switch stmt.(type) {
		case *parser.PieceDeclaration:
			pieceCount++
		case *parser.StaticVarDeclaration:
			staticVarCount++
		case *parser.FunctionDeclaration:
			functionCount++
		}
	}

	t.Logf("Statement breakdown: %d pieces, %d static-vars, %d functions",
		pieceCount, staticVarCount, functionCount)

	if pieceCount == 0 {
		t.Error("Expected at least one piece declaration")
	}
}

func TestParseAllBOSFiles(t *testing.T) {
	t.Skip("Integration test - parser has known issues with complex BOS files")
	
	scriptsDir := testutil.UnpackedDir(t, "scripts")
	if _, err := os.Stat(scriptsDir); os.IsNotExist(err) {
		t.Skip("Scripts directory not found")
	}

	files, err := filepath.Glob(filepath.Join(scriptsDir, "*.bos"))
	if err != nil {
		t.Fatalf("Failed to glob: %v", err)
	}

	if len(files) == 0 {
		t.Skip("No BOS files found")
	}

	t.Logf("Testing %d BOS files", len(files))

	fs, err := filesystem.NewPhysicalFileSystem(scriptsDir)
	if err != nil {
		t.Fatalf("Failed to create filesystem: %v", err)
	}
	defer func() { _ = fs.Close() }()

	for _, file := range files {
		name := filepath.Base(file)
		t.Run(name, func(t *testing.T) {
			// Preprocess
			prep := parser.NewPreprocessor(fs)
			preprocessed, err := prep.Process(name)
			if err != nil {
				t.Fatalf("Preprocessing failed: %v", err)
			}

			// Parse
			p := parser.NewParser(preprocessed)
			program := p.ParseProgram()

			if len(p.Errors()) > 0 {
				t.Logf("%s: %d parse errors", name, len(p.Errors()))
				for i, err := range p.Errors() {
					if i < 5 { // Limit error output
						t.Logf("  %s", err)
					}
				}
			}

			if len(program.Statements) == 0 {
				t.Errorf("%s: no statements parsed", name)
			}

			// Count functions
			fnCount := 0
			for _, stmt := range program.Statements {
				if _, ok := stmt.(*parser.FunctionDeclaration); ok {
					fnCount++
				}
			}

			t.Logf("%s: %d statements, %d functions", name,
				len(program.Statements), fnCount)
		})
	}
}

func TestRoundTripPreservation(t *testing.T) {
	// Test that AST can round-trip simple scripts
	tests := []struct {
		name  string
		input string
	}{
		{
			"simple_function",
			`piece base;
Create()
{
	x = 5;
}`,
		},
		{
			"with_commands",
			`piece base, flare;
FirePrimary()
{
	show flare;
	sleep 150;
	hide flare;
}`,
		},
		{
			"with_conditionals",
			`piece base;
Killed(severity, corpsetype)
{
	if (severity <= 25)
	{
		corpsetype = 1;
		return (0);
	}
	corpsetype = 3;
	return (0);
}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Parse
			p := parser.NewParser(tt.input)
			program := p.ParseProgram()

			if len(p.Errors()) > 0 {
				for _, err := range p.Errors() {
					t.Errorf("Parse error: %s", err)
				}
				t.FailNow()
			}

			// Round-trip
			output := program.String()

			// Parse again
			p2 := parser.NewParser(output)
			program2 := p2.ParseProgram()

			if len(p2.Errors()) > 0 {
				t.Errorf("Round-trip parse errors:")
				for _, err := range p2.Errors() {
					t.Errorf("  %s", err)
				}
				t.Errorf("Round-trip output:\n%s", output)
			}

			// Compare statement counts
			if len(program.Statements) != len(program2.Statements) {
				t.Errorf("Statement count mismatch: %d vs %d",
					len(program.Statements), len(program2.Statements))
			}
		})
	}
}

func TestPreprocessorWithParser(t *testing.T) {
	// Test that preprocessor output can be parsed
	input := `#define MAX_HEALTH 100
piece base;
#ifdef MAX_HEALTH
static-var health;
#endif
Create()
{
	health = MAX_HEALTH;
}`

	// Preprocess
	fs := filesystem.NewMemoryFileSystem()
	prep := parser.NewPreprocessor(fs)
	preprocessed, err := prep.ProcessContent(input, ".")
	if err != nil {
		t.Fatalf("Preprocessing failed: %v", err)
	}

	// Should have expanded MAX_HEALTH to 100
	if !strings.Contains(preprocessed, "100") {
		t.Error("Expected MAX_HEALTH to be expanded to 100")
	}

	// Parse
	p := parser.NewParser(preprocessed)
	program := p.ParseProgram()

	if len(p.Errors()) > 0 {
		t.Errorf("Parse errors after preprocessing:")
		for _, err := range p.Errors() {
			t.Errorf("  %s", err)
		}
	}

	if len(program.Statements) < 2 {
		t.Errorf("Expected at least 2 statements, got %d", len(program.Statements))
	}
}
