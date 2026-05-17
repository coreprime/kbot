package parser

import (
	"testing"
)

func TestParserPieceDeclaration(t *testing.T) {
	input := "piece base, turret, barrel;"
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	if len(program.Statements) != 1 {
		t.Fatalf("Expected 1 statement, got %d", len(program.Statements))
	}
	
	stmt, ok := program.Statements[0].(*PieceDeclaration)
	if !ok {
		t.Fatalf("Expected PieceDeclaration, got %T", program.Statements[0])
	}
	
	if len(stmt.Names) != 3 {
		t.Errorf("Expected 3 names, got %d", len(stmt.Names))
	}
	
	expectedNames := []string{"base", "turret", "barrel"}
	for i, name := range expectedNames {
		if stmt.Names[i] != name {
			t.Errorf("Name %d: expected %s, got %s", i, name, stmt.Names[i])
		}
	}
}

func TestParserStaticVarDeclaration(t *testing.T) {
	input := "static-var restore_delay, moving;"
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	if len(program.Statements) != 1 {
		t.Fatalf("Expected 1 statement, got %d", len(program.Statements))
	}
	
	stmt, ok := program.Statements[0].(*StaticVarDeclaration)
	if !ok {
		t.Fatalf("Expected StaticVarDeclaration, got %T", program.Statements[0])
	}
	
	if len(stmt.Names) != 2 {
		t.Errorf("Expected 2 names, got %d", len(stmt.Names))
	}
}

func TestParserFunctionDeclaration(t *testing.T) {
	input := `Create()
{
	x = 5;
}`
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	if len(program.Statements) != 1 {
		t.Fatalf("Expected 1 statement, got %d", len(program.Statements))
	}
	
	fn, ok := program.Statements[0].(*FunctionDeclaration)
	if !ok {
		t.Fatalf("Expected FunctionDeclaration, got %T", program.Statements[0])
	}
	
	if fn.Name != "Create" {
		t.Errorf("Expected function name 'Create', got %s", fn.Name)
	}
	
	if len(fn.Parameters) != 0 {
		t.Errorf("Expected 0 parameters, got %d", len(fn.Parameters))
	}
	
	if len(fn.Body.Statements) != 1 {
		t.Errorf("Expected 1 body statement, got %d", len(fn.Body.Statements))
	}
}

func TestParserFunctionWithParams(t *testing.T) {
	input := `SweetSpot(piecenum)
{
	piecenum = base;
}`
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	fn := program.Statements[0].(*FunctionDeclaration)
	
	if len(fn.Parameters) != 1 {
		t.Fatalf("Expected 1 parameter, got %d", len(fn.Parameters))
	}
	
	if fn.Parameters[0] != "piecenum" {
		t.Errorf("Expected parameter 'piecenum', got %s", fn.Parameters[0])
	}
}

func TestParserIfStatement(t *testing.T) {
	input := `if (x <= 25)
{
	y = 1;
}
else
{
	y = 2;
}`
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	if len(program.Statements) != 1 {
		t.Fatalf("Expected 1 statement, got %d", len(program.Statements))
	}
	
	ifStmt, ok := program.Statements[0].(*IfStatement)
	if !ok {
		t.Fatalf("Expected IfStatement, got %T", program.Statements[0])
	}
	
	if ifStmt.Condition == nil {
		t.Error("Expected condition")
	}
	
	if ifStmt.Consequence == nil {
		t.Error("Expected consequence")
	}
	
	if ifStmt.Alternative == nil {
		t.Error("Expected alternative")
	}
}

func TestParserWhileStatement(t *testing.T) {
	input := `while (x > 0)
{
	x = x - 1;
}`
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	whileStmt, ok := program.Statements[0].(*WhileStatement)
	if !ok {
		t.Fatalf("Expected WhileStatement, got %T", program.Statements[0])
	}
	
	if whileStmt.Condition == nil {
		t.Error("Expected condition")
	}
	
	if whileStmt.Body == nil {
		t.Error("Expected body")
	}
}

func TestParserReturnStatement(t *testing.T) {
	input := "return (0);"
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	returnStmt, ok := program.Statements[0].(*ReturnStatement)
	if !ok {
		t.Fatalf("Expected ReturnStatement, got %T", program.Statements[0])
	}
	
	if returnStmt.ReturnValue == nil {
		t.Error("Expected return value")
	}
}

func TestParserCommandStatement(t *testing.T) {
	tests := []struct {
		input       string
		command     string
		minArgs     int
	}{
		{"show flare;", "show", 1},
		{"hide flare;", "hide", 1},
		{"sleep 150;", "sleep", 1},
		{"move barrel to z-axis [10] speed [500];", "move", 5},
		{"turn turret to y-axis <90> now;", "turn", 3},
		{"emit-sfx 1024 from base;", "emit-sfx", 3},
	}
	
	for _, tt := range tests {
		p := NewParser(tt.input)
		program := p.ParseProgram()
		checkParserErrors(t, p)
		
		if len(program.Statements) != 1 {
			t.Errorf("Input %q: expected 1 statement, got %d", tt.input, len(program.Statements))
			continue
		}
		
		cmd, ok := program.Statements[0].(*CommandStatement)
		if !ok {
			t.Errorf("Input %q: expected CommandStatement, got %T", tt.input, program.Statements[0])
			continue
		}
		
		if cmd.Command != tt.command {
			t.Errorf("Input %q: expected command %s, got %s", tt.input, tt.command, cmd.Command)
		}
		
		if len(cmd.Args) < tt.minArgs {
			t.Errorf("Input %q: expected at least %d args, got %d", tt.input, tt.minArgs, len(cmd.Args))
		}
	}
}

func TestParserExpressions(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"x = 5;", "(x = 5)"},
		{"x = y + 1;", "(x = (y + 1))"},
		{"x = y - z * 2;", "(x = (y - (z * 2)))"},
		{"x = (y + z) * 2;", "(x = ((y + z) * 2))"},
	}
	
	for _, tt := range tests {
		p := NewParser(tt.input)
		program := p.ParseProgram()
		checkParserErrors(t, p)
		
		if len(program.Statements) != 1 {
			t.Errorf("Input %q: expected 1 statement, got %d", tt.input, len(program.Statements))
			continue
		}
		
		exprStmt, ok := program.Statements[0].(*ExpressionStatement)
		if !ok {
			t.Errorf("Input %q: expected ExpressionStatement, got %T", tt.input, program.Statements[0])
			continue
		}
		
		if exprStmt.Expression.String() != tt.expected {
			t.Errorf("Input %q: expected %s, got %s", tt.input, tt.expected, exprStmt.Expression.String())
		}
	}
}

func TestParserCallExpression(t *testing.T) {
	input := "start-script SmokeUnit();"
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	cmd, ok := program.Statements[0].(*CommandStatement)
	if !ok {
		t.Fatalf("Expected CommandStatement, got %T", program.Statements[0])
	}
	
	if len(cmd.Args) < 1 {
		t.Fatal("Expected at least 1 argument")
	}
	
	callExpr, ok := cmd.Args[0].(*CallExpression)
	if !ok {
		t.Fatalf("Expected CallExpression, got %T", cmd.Args[0])
	}
	
	ident, ok := callExpr.Function.(*Identifier)
	if !ok {
		t.Fatalf("Expected Identifier, got %T", callExpr.Function)
	}
	
	if ident.Value != "SmokeUnit" {
		t.Errorf("Expected function name 'SmokeUnit', got %s", ident.Value)
	}
}

func TestParserRealScript(t *testing.T) {
	input := `piece base;

Create()
{
	start-script SmokeUnit();
}

FirePrimary()
{
	show flare;
	sleep 150;
	hide flare;
}

Killed(severity, corpsetype)
{
	if (severity <= 25)
	{
		corpsetype = 1;
		return (0);
	}
	corpsetype = 3;
	return (0);
}`
	
	p := NewParser(input)
	program := p.ParseProgram()
	checkParserErrors(t, p)
	
	if len(program.Statements) != 4 {
		t.Fatalf("Expected 4 statements, got %d", len(program.Statements))
	}
	
	// Check piece declaration
	_, ok := program.Statements[0].(*PieceDeclaration)
	if !ok {
		t.Errorf("Statement 0: expected PieceDeclaration, got %T", program.Statements[0])
	}
	
	// Check functions
	for i := 1; i < 4; i++ {
		_, ok := program.Statements[i].(*FunctionDeclaration)
		if !ok {
			t.Errorf("Statement %d: expected FunctionDeclaration, got %T", i, program.Statements[i])
		}
	}
	
	// Test round-trip
	output := program.String()
	if output == "" {
		t.Error("Program.String() returned empty")
	}
	
	t.Logf("Round-trip output:\n%s", output)
}

func checkParserErrors(t *testing.T, p *Parser) {
	errors := p.Errors()
	if len(errors) == 0 {
		return
	}
	
	t.Errorf("Parser had %d errors:", len(errors))
	for _, msg := range errors {
		t.Errorf("  %s", msg)
	}
	t.FailNow()
}
