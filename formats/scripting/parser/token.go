package parser

import "fmt"

// TokenType represents the type of a token
type TokenType int

const (
	// Special tokens
	TOKEN_EOF TokenType = iota
	TOKEN_ILLEGAL
	TOKEN_COMMENT
	TOKEN_WHITESPACE
	TOKEN_NEWLINE

	// Literals
	TOKEN_IDENT     // identifier, piece name, variable
	TOKEN_NUMBER    // 123, -456
	TOKEN_STRING    // "string"

	// Keywords
	TOKEN_PIECE
	TOKEN_STATIC_VAR
	TOKEN_WHILE
	TOKEN_IF
	TOKEN_ELSE
	TOKEN_RETURN
	TOKEN_VAR

	// Commands (case-insensitive in BOS)
	TOKEN_MOVE
	TOKEN_TURN
	TOKEN_SPIN
	TOKEN_STOP_SPIN
	TOKEN_SHOW
	TOKEN_HIDE
	TOKEN_CACHE
	TOKEN_DONT_CACHE
	TOKEN_SHADE
	TOKEN_DONT_SHADE
	TOKEN_EMIT_SFX
	TOKEN_EXPLODE
	TOKEN_SLEEP
	TOKEN_WAIT_FOR_TURN
	TOKEN_WAIT_FOR_MOVE
	TOKEN_CALL_SCRIPT
	TOKEN_START_SCRIPT
	TOKEN_SIGNAL
	TOKEN_SET_SIGNAL_MASK
	TOKEN_GET
	TOKEN_SET
	TOKEN_RAND
	TOKEN_ATTACH_UNIT
	TOKEN_DROP_UNIT

	// Keywords for commands
	TOKEN_TO
	TOKEN_ALONG
	TOKEN_AROUND
	TOKEN_SPEED
	TOKEN_NOW
	TOKEN_ACCELERATE
	TOKEN_DECELERATE
	TOKEN_FROM
	TOKEN_TYPE

	// Axes
	TOKEN_X_AXIS
	TOKEN_Y_AXIS
	TOKEN_Z_AXIS

	// Operators
	TOKEN_ASSIGN    // =
	TOKEN_PLUS      // +
	TOKEN_MINUS     // -
	TOKEN_STAR      // *
	TOKEN_SLASH     // /
	TOKEN_PERCENT   // %
	TOKEN_PIPE      // |
	TOKEN_AMP       // &
	TOKEN_LT        // <
	TOKEN_GT        // >
	TOKEN_LE        // <=
	TOKEN_GE        // >=
	TOKEN_EQ        // ==
	TOKEN_NE        // !=
	TOKEN_NOT       // !
	TOKEN_AND       // &&
	TOKEN_OR        // ||

	// Delimiters
	TOKEN_LPAREN    // (
	TOKEN_RPAREN    // )
	TOKEN_LBRACE    // {
	TOKEN_RBRACE    // }
	TOKEN_LBRACKET  // [
	TOKEN_RBRACKET  // ]
	TOKEN_COMMA     // ,
	TOKEN_SEMICOLON // ;
)

var tokenNames = map[TokenType]string{
	TOKEN_EOF:              "EOF",
	TOKEN_ILLEGAL:          "ILLEGAL",
	TOKEN_COMMENT:          "COMMENT",
	TOKEN_WHITESPACE:       "WHITESPACE",
	TOKEN_NEWLINE:          "NEWLINE",
	TOKEN_IDENT:            "IDENT",
	TOKEN_NUMBER:           "NUMBER",
	TOKEN_STRING:           "STRING",
	TOKEN_PIECE:            "piece",
	TOKEN_STATIC_VAR:       "static-var",
	TOKEN_WHILE:            "while",
	TOKEN_IF:               "if",
	TOKEN_ELSE:             "else",
	TOKEN_RETURN:           "return",
	TOKEN_VAR:              "var",
	TOKEN_MOVE:             "move",
	TOKEN_TURN:             "turn",
	TOKEN_SPIN:             "spin",
	TOKEN_STOP_SPIN:        "stop-spin",
	TOKEN_SHOW:             "show",
	TOKEN_HIDE:             "hide",
	TOKEN_CACHE:            "cache",
	TOKEN_DONT_CACHE:       "dont-cache",
	TOKEN_SHADE:            "shade",
	TOKEN_DONT_SHADE:       "dont-shade",
	TOKEN_EMIT_SFX:         "emit-sfx",
	TOKEN_EXPLODE:          "explode",
	TOKEN_SLEEP:            "sleep",
	TOKEN_WAIT_FOR_TURN:    "wait-for-turn",
	TOKEN_WAIT_FOR_MOVE:    "wait-for-move",
	TOKEN_CALL_SCRIPT:      "call-script",
	TOKEN_START_SCRIPT:     "start-script",
	TOKEN_SIGNAL:           "signal",
	TOKEN_SET_SIGNAL_MASK:  "set-signal-mask",
	TOKEN_GET:              "get",
	TOKEN_SET:              "set",
	TOKEN_RAND:             "rand",
	TOKEN_ATTACH_UNIT:      "attach-unit",
	TOKEN_DROP_UNIT:        "drop-unit",
	TOKEN_TO:               "to",
	TOKEN_ALONG:            "along",
	TOKEN_AROUND:           "around",
	TOKEN_SPEED:            "speed",
	TOKEN_NOW:              "now",
	TOKEN_ACCELERATE:       "accelerate",
	TOKEN_DECELERATE:       "decelerate",
	TOKEN_FROM:             "from",
	TOKEN_TYPE:             "type",
	TOKEN_X_AXIS:           "x-axis",
	TOKEN_Y_AXIS:           "y-axis",
	TOKEN_Z_AXIS:           "z-axis",
	TOKEN_ASSIGN:           "=",
	TOKEN_PLUS:             "+",
	TOKEN_MINUS:            "-",
	TOKEN_STAR:             "*",
	TOKEN_SLASH:            "/",
	TOKEN_PERCENT:          "%",
	TOKEN_PIPE:             "|",
	TOKEN_AMP:              "&",
	TOKEN_LT:               "<",
	TOKEN_GT:               ">",
	TOKEN_LE:               "<=",
	TOKEN_GE:               ">=",
	TOKEN_EQ:               "==",
	TOKEN_NE:               "!=",
	TOKEN_NOT:              "!",
	TOKEN_AND:              "&&",
	TOKEN_OR:               "||",
	TOKEN_LPAREN:           "(",
	TOKEN_RPAREN:           ")",
	TOKEN_LBRACE:           "{",
	TOKEN_RBRACE:           "}",
	TOKEN_LBRACKET:         "[",
	TOKEN_RBRACKET:         "]",
	TOKEN_COMMA:            ",",
	TOKEN_SEMICOLON:        ";",
}

func (t TokenType) String() string {
	if name, ok := tokenNames[t]; ok {
		return name
	}
	return fmt.Sprintf("TokenType(%d)", t)
}

// Token represents a lexical token
type Token struct {
	Type    TokenType
	Literal string
	Line    int
	Column  int
}

func (t Token) String() string {
	return fmt.Sprintf("%d:%d %s %q", t.Line, t.Column, t.Type, t.Literal)
}

// Keywords maps lowercase keywords to token types
var keywords = map[string]TokenType{
	"piece":            TOKEN_PIECE,
	"static-var":       TOKEN_STATIC_VAR,
	"while":            TOKEN_WHILE,
	"if":               TOKEN_IF,
	"else":             TOKEN_ELSE,
	"return":           TOKEN_RETURN,
	"var":              TOKEN_VAR,
	"move":             TOKEN_MOVE,
	"turn":             TOKEN_TURN,
	"spin":             TOKEN_SPIN,
	"stop-spin":        TOKEN_STOP_SPIN,
	"show":             TOKEN_SHOW,
	"hide":             TOKEN_HIDE,
	"cache":            TOKEN_CACHE,
	"dont-cache":       TOKEN_DONT_CACHE,
	"shade":            TOKEN_SHADE,
	"dont-shade":       TOKEN_DONT_SHADE,
	"emit-sfx":         TOKEN_EMIT_SFX,
	"explode":          TOKEN_EXPLODE,
	"sleep":            TOKEN_SLEEP,
	"wait-for-turn":    TOKEN_WAIT_FOR_TURN,
	"wait-for-move":    TOKEN_WAIT_FOR_MOVE,
	"call-script":      TOKEN_CALL_SCRIPT,
	"start-script":     TOKEN_START_SCRIPT,
	"signal":           TOKEN_SIGNAL,
	"set-signal-mask":  TOKEN_SET_SIGNAL_MASK,
	"get":              TOKEN_GET,
	"set":              TOKEN_SET,
	"rand":             TOKEN_RAND,
	"attach-unit":      TOKEN_ATTACH_UNIT,
	"drop-unit":        TOKEN_DROP_UNIT,
	"to":               TOKEN_TO,
	"along":            TOKEN_ALONG,
	"around":           TOKEN_AROUND,
	"speed":            TOKEN_SPEED,
	"now":              TOKEN_NOW,
	"accelerate":       TOKEN_ACCELERATE,
	"decelerate":       TOKEN_DECELERATE,
	"from":             TOKEN_FROM,
	"type":             TOKEN_TYPE,
	"x-axis":           TOKEN_X_AXIS,
	"y-axis":           TOKEN_Y_AXIS,
	"z-axis":           TOKEN_Z_AXIS,
}

// LookupIdent checks if an identifier is a keyword
func LookupIdent(ident string) TokenType {
	if tok, ok := keywords[ident]; ok {
		return tok
	}
	return TOKEN_IDENT
}
