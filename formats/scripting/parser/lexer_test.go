package parser

import (
	"testing"
)

func TestLexerBasicTokens(t *testing.T) {
	input := "piece base, turret; static-var moving; x = 5 + 3; if (x <= 10) { }"

	tests := []struct {
		expectedType    TokenType
		expectedLiteral string
	}{
		{TOKEN_PIECE, "piece"},
		{TOKEN_IDENT, "base"},
		{TOKEN_COMMA, ","},
		{TOKEN_IDENT, "turret"},
		{TOKEN_SEMICOLON, ";"},
		{TOKEN_STATIC_VAR, "static-var"},
		{TOKEN_IDENT, "moving"},
		{TOKEN_SEMICOLON, ";"},
		{TOKEN_IDENT, "x"},
		{TOKEN_ASSIGN, "="},
		{TOKEN_NUMBER, "5"},
		{TOKEN_PLUS, "+"},
		{TOKEN_NUMBER, "3"},
		{TOKEN_SEMICOLON, ";"},
		{TOKEN_IF, "if"},
		{TOKEN_LPAREN, "("},
		{TOKEN_IDENT, "x"},
		{TOKEN_LE, "<="},
		{TOKEN_NUMBER, "10"},
		{TOKEN_RPAREN, ")"},
		{TOKEN_LBRACE, "{"},
		{TOKEN_RBRACE, "}"},
		{TOKEN_EOF, ""},
	}

	l := NewLexer(input, false)

	for i, tt := range tests {
		tok := l.NextToken()
		if tok.Type != tt.expectedType {
			t.Fatalf("tests[%d] - tokentype wrong. expected=%q, got=%q (literal=%q)",
				i, tt.expectedType, tok.Type, tok.Literal)
		}
		if tok.Literal != tt.expectedLiteral {
			t.Fatalf("tests[%d] - literal wrong. expected=%q, got=%q",
				i, tt.expectedLiteral, tok.Literal)
		}
	}
}

func TestLexerCommands(t *testing.T) {
	input := `move barrel to z-axis [10] speed [500];
turn turret to y-axis <90> now;
spin piece around x-axis speed <50>;
stop-spin piece around x-axis;
show flare;
hide flare;
emit-sfx 1024 from base;
sleep 150;`

	l := NewLexer(input, false)

	expectedKeywords := []TokenType{
		TOKEN_MOVE, TOKEN_TURN, TOKEN_SPIN, TOKEN_STOP_SPIN,
		TOKEN_SHOW, TOKEN_HIDE, TOKEN_EMIT_SFX, TOKEN_SLEEP,
	}

	keywordCount := 0
	for {
		tok := l.NextToken()
		if tok.Type == TOKEN_EOF {
			break
		}
		
		// Check if it's one of our expected keywords
		for _, expected := range expectedKeywords {
			if tok.Type == expected {
				keywordCount++
				t.Logf("Found keyword: %s", tok.Literal)
				break
			}
		}
	}

	if keywordCount != len(expectedKeywords) {
		t.Errorf("Expected %d keywords, found %d", len(expectedKeywords), keywordCount)
	}
}

func TestLexerComments(t *testing.T) {
	input := `// Line comment
piece base; /* block
comment */ static-var x;`

	l := NewLexer(input, true)
	
	var tokens []Token
	for {
		tok := l.NextToken()
		tokens = append(tokens, tok)
		if tok.Type == TOKEN_EOF {
			break
		}
	}

	commentCount := 0
	for _, tok := range tokens {
		if tok.Type == TOKEN_COMMENT {
			commentCount++
		}
	}

	if commentCount != 2 {
		t.Errorf("Expected 2 comments, found %d", commentCount)
	}
}

func TestLexerNumbers(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"123", "123"},
		{"-456", "-456"},
		{"3.14", "3.14"},
		{"-2.5", "-2.5"},
	}

	for _, tt := range tests {
		l := NewLexer(tt.input, false)
		tok := l.NextToken()
		
		if tok.Type != TOKEN_NUMBER {
			t.Errorf("Expected NUMBER token, got %s", tok.Type)
		}
		if tok.Literal != tt.expected {
			t.Errorf("Expected %q, got %q", tt.expected, tok.Literal)
		}
	}
}

func TestLexerOperators(t *testing.T) {
	input := `== != <= >= < > && || + - * / % | &`

	expected := []TokenType{
		TOKEN_EQ, TOKEN_NE, TOKEN_LE, TOKEN_GE, TOKEN_LT, TOKEN_GT,
		TOKEN_AND, TOKEN_OR, TOKEN_PLUS, TOKEN_MINUS, TOKEN_STAR,
		TOKEN_SLASH, TOKEN_PERCENT, TOKEN_PIPE, TOKEN_AMP,
	}

	l := NewLexer(input, false)
	
	for i, expectedType := range expected {
		tok := l.NextToken()
		if tok.Type != expectedType {
			t.Errorf("Token %d: expected %s, got %s", i, expectedType, tok.Type)
		}
	}
}

func TestLexerRealScript(t *testing.T) {
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
}`

	l := NewLexer(input, false)
	tokens := l.AllTokens()

	// Should have: piece, base, ;, ident, (), {, start-script, ident, (), ;, }, etc.
	if len(tokens) < 10 {
		t.Errorf("Expected at least 10 tokens, got %d", len(tokens))
	}

	// Check some key tokens
	foundPiece := false
	foundStartScript := false
	foundShow := false

	for _, tok := range tokens {
		switch tok.Type {
		case TOKEN_PIECE:
			foundPiece = true
		case TOKEN_START_SCRIPT:
			foundStartScript = true
		case TOKEN_SHOW:
			foundShow = true
		}
	}

	if !foundPiece {
		t.Error("Expected to find 'piece' keyword")
	}
	if !foundStartScript {
		t.Error("Expected to find 'start-script' keyword")
	}
	if !foundShow {
		t.Error("Expected to find 'show' keyword")
	}
}

func TestLexerPreserveWhitespace(t *testing.T) {
	input := "x  =  5"

	// Without preserving whitespace
	tokens1 := TokensNoWS(input)
	
	// Should be: x, =, 5, EOF
	if len(tokens1) != 4 {
		t.Errorf("Without WS: expected 4 tokens, got %d", len(tokens1))
	}

	// With preserving whitespace
	l2 := NewLexer(input, true)
	var tokens2 []Token
	for {
		tok := l2.NextToken()
		tokens2 = append(tokens2, tok)
		if tok.Type == TOKEN_EOF {
			break
		}
	}

	// Should include whitespace tokens
	wsCount := 0
	for _, tok := range tokens2 {
		if tok.Type == TOKEN_WHITESPACE {
			wsCount++
		}
	}

	if wsCount == 0 {
		t.Error("Expected to preserve whitespace tokens")
	}
}

func TestLexerHyphenatedKeywords(t *testing.T) {
	hyphenated := []string{
		"static-var", "stop-spin", "dont-cache", "dont-shade",
		"emit-sfx", "wait-for-turn", "wait-for-move",
		"call-script", "start-script", "set-signal-mask",
		"attach-unit", "drop-unit", "x-axis", "y-axis", "z-axis",
	}

	for _, keyword := range hyphenated {
		l := NewLexer(keyword, false)
		tok := l.NextToken()
		
		if tok.Literal != keyword {
			t.Errorf("Literal mismatch: expected %q, got %q", keyword, tok.Literal)
		}
		
		if tok.Type == TOKEN_IDENT {
			t.Errorf("Keyword %q not recognized, got IDENT", keyword)
		}
	}
}
