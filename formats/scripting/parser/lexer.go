package parser

import (
	"unicode"
)

// Lexer tokenizes BOS source code
type Lexer struct {
	input        string
	position     int  // current position in input
	readPosition int  // current reading position (after current char)
	ch           byte // current char under examination
	line         int
	column       int
	preserveWS   bool // preserve whitespace for round-trip
}

// NewLexer creates a new lexer for the input
func NewLexer(input string, preserveWS bool) *Lexer {
	l := &Lexer{
		input:      input,
		line:       1,
		column:     0,
		preserveWS: preserveWS,
	}
	l.readChar()
	return l
}

// readChar advances to the next character
func (l *Lexer) readChar() {
	if l.readPosition >= len(l.input) {
		l.ch = 0 // EOF
	} else {
		l.ch = l.input[l.readPosition]
	}
	l.position = l.readPosition
	l.readPosition++
	l.column++
}

// peekChar returns the next character without advancing
func (l *Lexer) peekChar() byte {
	if l.readPosition >= len(l.input) {
		return 0
	}
	return l.input[l.readPosition]
}

// NextToken returns the next token
func (l *Lexer) NextToken() Token {
	var tok Token

	// Skip whitespace unless preserving
	if !l.preserveWS {
		l.skipWhitespace()
	}

	tok.Line = l.line
	tok.Column = l.column

	switch l.ch {
	case 0:
		tok.Type = TOKEN_EOF
		tok.Literal = ""
	case '\n':
		tok.Type = TOKEN_NEWLINE
		tok.Literal = "\n"
		l.line++
		l.column = 0
		l.readChar()
	case '\r':
		// Handle \r\n or just \r
		tok.Type = TOKEN_NEWLINE
		tok.Literal = "\r"
		l.readChar()
		if l.ch == '\n' {
			tok.Literal += "\n"
			l.readChar()
		}
		l.line++
		l.column = 0
	case ' ', '\t':
		if l.preserveWS {
			tok.Type = TOKEN_WHITESPACE
			tok.Literal = l.readWhitespace()
		} else {
			return l.NextToken()
		}
	case '/':
		if l.peekChar() == '/' {
			tok.Type = TOKEN_COMMENT
			tok.Literal = l.readLineComment()
		} else if l.peekChar() == '*' {
			tok.Type = TOKEN_COMMENT
			tok.Literal = l.readBlockComment()
		} else {
			tok.Type = TOKEN_SLASH
			tok.Literal = "/"
			l.readChar()
		}
	case '=':
		if l.peekChar() == '=' {
			ch := l.ch
			l.readChar()
			tok.Type = TOKEN_EQ
			tok.Literal = string(ch) + string(l.ch)
			l.readChar()
		} else {
			tok.Type = TOKEN_ASSIGN
			tok.Literal = "="
			l.readChar()
		}
	case '+':
		tok.Type = TOKEN_PLUS
		tok.Literal = "+"
		l.readChar()
	case '-':
		// Could be minus, negative number, or part of keyword
		if unicode.IsDigit(rune(l.peekChar())) {
			// Negative number
			tok.Type = TOKEN_NUMBER
			tok.Literal = l.readNumber()
		} else if isLetter(l.peekChar()) {
			// Part of hyphenated keyword
			tok.Type = TOKEN_IDENT
			tok.Literal = l.readIdentifier()
			tok.Type = LookupIdent(tok.Literal)
		} else {
			tok.Type = TOKEN_MINUS
			tok.Literal = "-"
			l.readChar()
		}
	case '*':
		tok.Type = TOKEN_STAR
		tok.Literal = "*"
		l.readChar()
	case '%':
		tok.Type = TOKEN_PERCENT
		tok.Literal = "%"
		l.readChar()
	case '|':
		if l.peekChar() == '|' {
			ch := l.ch
			l.readChar()
			tok.Type = TOKEN_OR
			tok.Literal = string(ch) + string(l.ch)
			l.readChar()
		} else {
			tok.Type = TOKEN_PIPE
			tok.Literal = "|"
			l.readChar()
		}
	case '&':
		if l.peekChar() == '&' {
			ch := l.ch
			l.readChar()
			tok.Type = TOKEN_AND
			tok.Literal = string(ch) + string(l.ch)
			l.readChar()
		} else {
			tok.Type = TOKEN_AMP
			tok.Literal = "&"
			l.readChar()
		}
	case '<':
		if l.peekChar() == '=' {
			ch := l.ch
			l.readChar()
			tok.Type = TOKEN_LE
			tok.Literal = string(ch) + string(l.ch)
			l.readChar()
		} else {
			tok.Type = TOKEN_LT
			tok.Literal = "<"
			l.readChar()
		}
	case '>':
		if l.peekChar() == '=' {
			ch := l.ch
			l.readChar()
			tok.Type = TOKEN_GE
			tok.Literal = string(ch) + string(l.ch)
			l.readChar()
		} else {
			tok.Type = TOKEN_GT
			tok.Literal = ">"
			l.readChar()
		}
	case '!':
		if l.peekChar() == '=' {
			ch := l.ch
			l.readChar()
			tok.Type = TOKEN_NE
			tok.Literal = string(ch) + string(l.ch)
			l.readChar()
		} else {
			tok.Type = TOKEN_NOT
			tok.Literal = "!"
			l.readChar()
		}
	case '(':
		tok.Type = TOKEN_LPAREN
		tok.Literal = "("
		l.readChar()
	case ')':
		tok.Type = TOKEN_RPAREN
		tok.Literal = ")"
		l.readChar()
	case '{':
		tok.Type = TOKEN_LBRACE
		tok.Literal = "{"
		l.readChar()
	case '}':
		tok.Type = TOKEN_RBRACE
		tok.Literal = "}"
		l.readChar()
	case '[':
		tok.Type = TOKEN_LBRACKET
		tok.Literal = "["
		l.readChar()
	case ']':
		tok.Type = TOKEN_RBRACKET
		tok.Literal = "]"
		l.readChar()
	case ',':
		tok.Type = TOKEN_COMMA
		tok.Literal = ","
		l.readChar()
	case ';':
		tok.Type = TOKEN_SEMICOLON
		tok.Literal = ";"
		l.readChar()
	case '"':
		tok.Type = TOKEN_STRING
		tok.Literal = l.readString()
	default:
		if isLetter(l.ch) {
			tok.Literal = l.readIdentifier()
			tok.Type = LookupIdent(tok.Literal)
			return tok
		} else if unicode.IsDigit(rune(l.ch)) {
			tok.Type = TOKEN_NUMBER
			tok.Literal = l.readNumber()
			return tok
		} else {
			tok.Type = TOKEN_ILLEGAL
			tok.Literal = string(l.ch)
			l.readChar()
		}
	}

	return tok
}

// skipWhitespace skips whitespace characters (and comments when not preserving)
func (l *Lexer) skipWhitespace() {
	for {
		if l.ch == ' ' || l.ch == '\t' {
			l.readChar()
			continue
		}
		// Skip comments when not preserving whitespace
		if !l.preserveWS {
			if l.ch == '/' && l.peekChar() == '/' {
				l.skipLineComment()
				continue
			}
			if l.ch == '/' && l.peekChar() == '*' {
				l.skipBlockComment()
				continue
			}
		}
		break
	}
}

// skipLineComment skips a // comment
func (l *Lexer) skipLineComment() {
	for l.ch != '\n' && l.ch != 0 {
		l.readChar()
	}
}

// skipBlockComment skips a /* */ comment
func (l *Lexer) skipBlockComment() {
	l.readChar() // skip /
	l.readChar() // skip *
	
	for l.ch != 0 {
		if l.ch == '*' && l.peekChar() == '/' {
			l.readChar()
			l.readChar()
			break
		}
		if l.ch == '\n' {
			l.line++
			l.column = 0
		}
		l.readChar()
	}
}

// readWhitespace reads consecutive whitespace
func (l *Lexer) readWhitespace() string {
	position := l.position
	for l.ch == ' ' || l.ch == '\t' {
		l.readChar()
	}
	return l.input[position:l.position]
}

// readIdentifier reads an identifier (including hyphenated keywords)
func (l *Lexer) readIdentifier() string {
	position := l.position
	for isLetter(l.ch) || unicode.IsDigit(rune(l.ch)) || l.ch == '_' || l.ch == '-' {
		l.readChar()
	}
	return l.input[position:l.position]
}

// readNumber reads a number (integer or decimal)
func (l *Lexer) readNumber() string {
	position := l.position
	
	// Handle negative sign
	if l.ch == '-' {
		l.readChar()
	}
	
	// Read digits
	for unicode.IsDigit(rune(l.ch)) {
		l.readChar()
	}
	
	// Handle decimal point
	if l.ch == '.' && unicode.IsDigit(rune(l.peekChar())) {
		l.readChar()
		for unicode.IsDigit(rune(l.ch)) {
			l.readChar()
		}
	}
	
	return l.input[position:l.position]
}

// readString reads a quoted string
func (l *Lexer) readString() string {
	position := l.position + 1 // skip opening quote
	l.readChar()
	
	for l.ch != '"' && l.ch != 0 {
		if l.ch == '\\' && l.peekChar() == '"' {
			l.readChar() // skip backslash
		}
		l.readChar()
	}
	
	str := l.input[position:l.position]
	l.readChar() // skip closing quote
	return str
}

// readLineComment reads a // comment
func (l *Lexer) readLineComment() string {
	position := l.position
	for l.ch != '\n' && l.ch != 0 {
		l.readChar()
	}
	return l.input[position:l.position]
}

// readBlockComment reads a /* */ comment
func (l *Lexer) readBlockComment() string {
	position := l.position
	l.readChar() // skip /
	l.readChar() // skip *
	
	for l.ch != 0 {
		if l.ch == '*' && l.peekChar() == '/' {
			l.readChar()
			l.readChar()
			break
		}
		if l.ch == '\n' {
			l.line++
			l.column = 0
		}
		l.readChar()
	}
	
	return l.input[position:l.position]
}

// isLetter checks if a character is a letter
func isLetter(ch byte) bool {
	return unicode.IsLetter(rune(ch)) || ch == '_'
}

// AllTokens returns all tokens from the lexer
func (l *Lexer) AllTokens() []Token {
	var tokens []Token
	for {
		tok := l.NextToken()
		tokens = append(tokens, tok)
		if tok.Type == TOKEN_EOF {
			break
		}
	}
	return tokens
}

// TokensNoWS returns all non-whitespace tokens
func TokensNoWS(input string) []Token {
	l := NewLexer(input, false)
	var tokens []Token
	for {
		tok := l.NextToken()
		if tok.Type == TOKEN_NEWLINE {
			continue
		}
		tokens = append(tokens, tok)
		if tok.Type == TOKEN_EOF {
			break
		}
	}
	return tokens
}
