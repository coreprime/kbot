package parser

import (
	"fmt"
	"strconv"
)

// Parser precedence levels
const (
	_ int = iota
	LOWEST
	ASSIGN      // =
	OR          // ||
	AND         // &&
	EQUALS      // == or !=
	LESSGREATER // > or <
	BITWISE     // | &
	SUM         // + or -
	PRODUCT     // * / %
	PREFIX      // -x or !x
	CALL        // func()
)

var precedences = map[TokenType]int{
	TOKEN_ASSIGN:  ASSIGN,
	TOKEN_OR:      OR,
	TOKEN_AND:     AND,
	TOKEN_EQ:      EQUALS,
	TOKEN_NE:      EQUALS,
	TOKEN_LT:      LESSGREATER,
	TOKEN_GT:      LESSGREATER,
	TOKEN_LE:      LESSGREATER,
	TOKEN_GE:      LESSGREATER,
	TOKEN_PIPE:    BITWISE,
	TOKEN_AMP:     BITWISE,
	TOKEN_PLUS:    SUM,
	TOKEN_MINUS:   SUM,
	TOKEN_STAR:    PRODUCT,
	TOKEN_SLASH:   PRODUCT,
	TOKEN_PERCENT: PRODUCT,
	TOKEN_LPAREN:  CALL,
}

// Parser parses BOS source into an AST
type Parser struct {
	lexer     *Lexer
	errors    []string
	curToken  Token
	peekToken Token
}

// NewParser creates a new parser
func NewParser(input string) *Parser {
	p := &Parser{
		lexer:  NewLexer(input, false),
		errors: []string{},
	}
	
	// Read two tokens so curToken and peekToken are both set
	p.nextToken()
	p.nextToken()
	
	return p
}

// nextToken advances to the next token
func (p *Parser) nextToken() {
	p.curToken = p.peekToken
	p.peekToken = p.lexer.NextToken()
	
	// Skip newlines in most contexts
	for p.peekToken.Type == TOKEN_NEWLINE {
		p.peekToken = p.lexer.NextToken()
	}
}

// Errors returns parser errors
func (p *Parser) Errors() []string {
	return p.errors
}

// addError adds an error message
func (p *Parser) addError(msg string) {
	p.errors = append(p.errors, fmt.Sprintf("line %d: %s", p.curToken.Line, msg))
}

// curTokenIs checks if current token is of given type
func (p *Parser) curTokenIs(t TokenType) bool {
	return p.curToken.Type == t
}

// peekTokenIs checks if peek token is of given type
func (p *Parser) peekTokenIs(t TokenType) bool {
	return p.peekToken.Type == t
}

// expectPeek advances if peek token matches, otherwise errors
func (p *Parser) expectPeek(t TokenType) bool {
	if p.peekTokenIs(t) {
		p.nextToken()
		return true
	}
	p.addError(fmt.Sprintf("expected %s, got %s", t, p.peekToken.Type))
	return false
}

// peekPrecedence returns the precedence of peek token
func (p *Parser) peekPrecedence() int {
	if p, ok := precedences[p.peekToken.Type]; ok {
		return p
	}
	return LOWEST
}

// curPrecedence returns the precedence of current token
func (p *Parser) curPrecedence() int {
	if p, ok := precedences[p.curToken.Type]; ok {
		return p
	}
	return LOWEST
}

// ParseProgram parses the entire program
func (p *Parser) ParseProgram() *Program {
	program := &Program{
		Statements: []Statement{},
	}
	
	for !p.curTokenIs(TOKEN_EOF) {
		// Skip newlines at top level
		if p.curTokenIs(TOKEN_NEWLINE) {
			p.nextToken()
			continue
		}
		
		stmt := p.parseStatement()
		if stmt != nil {
			program.Statements = append(program.Statements, stmt)
		}
		p.nextToken()
	}
	
	return program
}

// parseStatement parses a statement
func (p *Parser) parseStatement() Statement {
	switch p.curToken.Type {
	case TOKEN_PIECE:
		return p.parsePieceDeclaration()
	case TOKEN_STATIC_VAR, TOKEN_VAR:
		return p.parseStaticVarDeclaration()
	case TOKEN_RETURN:
		return p.parseReturnStatement()
	case TOKEN_IF:
		return p.parseIfStatement()
	case TOKEN_WHILE:
		return p.parseWhileStatement()
	case TOKEN_IDENT:
		// Could be function declaration or expression
		if p.peekTokenIs(TOKEN_LPAREN) {
			return p.parseFunctionDeclaration()
		}
		return p.parseExpressionStatement()
	case TOKEN_COMMENT:
		// Skip comments that slip through
		return nil
	default:
		// Check if it's a command
		if p.isCommand(p.curToken.Type) {
			return p.parseCommandStatement()
		}
		return p.parseExpressionStatement()
	}
}

// parsePieceDeclaration parses: piece name1, name2, ...;
func (p *Parser) parsePieceDeclaration() *PieceDeclaration {
	stmt := &PieceDeclaration{Token: p.curToken}
	
	if !p.expectPeek(TOKEN_IDENT) {
		return nil
	}
	
	stmt.Names = []string{p.curToken.Literal}
	
	for p.peekTokenIs(TOKEN_COMMA) {
		p.nextToken() // skip comma
		if !p.expectPeek(TOKEN_IDENT) {
			return nil
		}
		stmt.Names = append(stmt.Names, p.curToken.Literal)
	}
	
	if !p.expectPeek(TOKEN_SEMICOLON) {
		return nil
	}
	
	return stmt
}

// parseStaticVarDeclaration parses: static-var name1, name2, ...;
func (p *Parser) parseStaticVarDeclaration() *StaticVarDeclaration {
	stmt := &StaticVarDeclaration{Token: p.curToken}
	
	if !p.expectPeek(TOKEN_IDENT) {
		return nil
	}
	
	stmt.Names = []string{p.curToken.Literal}
	
	for p.peekTokenIs(TOKEN_COMMA) {
		p.nextToken() // skip comma
		if !p.expectPeek(TOKEN_IDENT) {
			return nil
		}
		stmt.Names = append(stmt.Names, p.curToken.Literal)
	}
	
	if !p.expectPeek(TOKEN_SEMICOLON) {
		return nil
	}
	
	return stmt
}

// parseFunctionDeclaration parses: Name(params) { ... }
func (p *Parser) parseFunctionDeclaration() *FunctionDeclaration {
	stmt := &FunctionDeclaration{
		Token: p.curToken,
		Name:  p.curToken.Literal,
	}
	
	if !p.expectPeek(TOKEN_LPAREN) {
		return nil
	}
	
	stmt.Parameters = p.parseFunctionParameters()
	
	if !p.expectPeek(TOKEN_LBRACE) {
		return nil
	}
	
	stmt.Body = p.parseBlockStatement()
	
	return stmt
}

// parseFunctionParameters parses function parameter list
func (p *Parser) parseFunctionParameters() []string {
	params := []string{}
	
	if p.peekTokenIs(TOKEN_RPAREN) {
		p.nextToken()
		return params
	}
	
	p.nextToken()
	params = append(params, p.curToken.Literal)
	
	for p.peekTokenIs(TOKEN_COMMA) {
		p.nextToken() // skip comma
		p.nextToken() // get param
		params = append(params, p.curToken.Literal)
	}
	
	if !p.expectPeek(TOKEN_RPAREN) {
		return nil
	}
	
	return params
}

// parseBlockStatement parses: { ... }
func (p *Parser) parseBlockStatement() *BlockStatement {
	block := &BlockStatement{
		Token:      p.curToken,
		Statements: []Statement{},
	}
	
	p.nextToken()
	
	for !p.curTokenIs(TOKEN_RBRACE) && !p.curTokenIs(TOKEN_EOF) {
		// Skip newlines
		if p.curTokenIs(TOKEN_NEWLINE) {
			p.nextToken()
			continue
		}
		
		stmt := p.parseStatement()
		if stmt != nil {
			block.Statements = append(block.Statements, stmt)
		}
		p.nextToken()
	}
	
	return block
}

// parseReturnStatement parses: return (expr);
func (p *Parser) parseReturnStatement() *ReturnStatement {
	stmt := &ReturnStatement{Token: p.curToken}
	
	p.nextToken()
	
	// Optional parentheses
	hasParens := false
	if p.curTokenIs(TOKEN_LPAREN) {
		hasParens = true
		p.nextToken()
	}
	
	if !p.curTokenIs(TOKEN_SEMICOLON) {
		stmt.ReturnValue = p.parseExpression(LOWEST)
	}
	
	if hasParens {
		if !p.expectPeek(TOKEN_RPAREN) {
			return nil
		}
	}
	
	if p.peekTokenIs(TOKEN_SEMICOLON) {
		p.nextToken()
	}
	
	return stmt
}

// parseIfStatement parses: if (condition) { ... } else { ... }
func (p *Parser) parseIfStatement() *IfStatement {
	stmt := &IfStatement{Token: p.curToken}
	
	if !p.expectPeek(TOKEN_LPAREN) {
		return nil
	}
	
	p.nextToken()
	stmt.Condition = p.parseExpression(LOWEST)
	
	if !p.expectPeek(TOKEN_RPAREN) {
		return nil
	}
	
	if !p.expectPeek(TOKEN_LBRACE) {
		return nil
	}
	
	stmt.Consequence = p.parseBlockStatement()
	
	if p.peekTokenIs(TOKEN_ELSE) {
		p.nextToken()
		
		if !p.expectPeek(TOKEN_LBRACE) {
			return nil
		}
		
		stmt.Alternative = p.parseBlockStatement()
	}
	
	return stmt
}

// parseWhileStatement parses: while (condition) { ... }
func (p *Parser) parseWhileStatement() *WhileStatement {
	stmt := &WhileStatement{Token: p.curToken}
	
	if !p.expectPeek(TOKEN_LPAREN) {
		return nil
	}
	
	p.nextToken()
	stmt.Condition = p.parseExpression(LOWEST)
	
	if !p.expectPeek(TOKEN_RPAREN) {
		return nil
	}
	
	if !p.expectPeek(TOKEN_LBRACE) {
		return nil
	}
	
	stmt.Body = p.parseBlockStatement()
	
	return stmt
}

// parseCommandStatement parses BOS commands
func (p *Parser) parseCommandStatement() *CommandStatement {
	stmt := &CommandStatement{
		Token:   p.curToken,
		Command: p.curToken.Literal,
		Args:    []Expression{},
	}
	
	// Parse arguments until semicolon
	for !p.peekTokenIs(TOKEN_SEMICOLON) && !p.peekTokenIs(TOKEN_EOF) {
		p.nextToken()
		arg := p.parseExpression(LOWEST)
		if arg != nil {
			stmt.Args = append(stmt.Args, arg)
		}
	}
	
	if p.peekTokenIs(TOKEN_SEMICOLON) {
		p.nextToken()
	}
	
	return stmt
}

// parseExpressionStatement parses an expression as a statement
func (p *Parser) parseExpressionStatement() *ExpressionStatement {
	stmt := &ExpressionStatement{Token: p.curToken}
	stmt.Expression = p.parseExpression(LOWEST)
	
	if p.peekTokenIs(TOKEN_SEMICOLON) {
		p.nextToken()
	}
	
	return stmt
}

// parseExpression parses an expression with precedence
func (p *Parser) parseExpression(precedence int) Expression {
	// Parse prefix
	var leftExp Expression
	
	switch p.curToken.Type {
	case TOKEN_IDENT:
		leftExp = &Identifier{Token: p.curToken, Value: p.curToken.Literal}
	case TOKEN_NUMBER:
		leftExp = &NumberLiteral{Token: p.curToken, Value: p.curToken.Literal}
	case TOKEN_STRING:
		leftExp = &StringLiteral{Token: p.curToken, Value: p.curToken.Literal}
	case TOKEN_MINUS, TOKEN_NOT:
		leftExp = p.parsePrefixExpression()
	case TOKEN_LPAREN:
		leftExp = p.parseGroupedExpression()
	case TOKEN_LBRACKET:
		leftExp = p.parseBracketExpression()
	case TOKEN_LT:
		leftExp = p.parseAngleBracketExpression()
	case TOKEN_X_AXIS, TOKEN_Y_AXIS, TOKEN_Z_AXIS:
		leftExp = &AxisExpression{Token: p.curToken, Axis: p.curToken.Literal}
	default:
		// Check if it's a keyword that can be an expression
		if p.isKeywordExpression(p.curToken.Type) {
			leftExp = &KeywordExpression{Token: p.curToken, Keyword: p.curToken.Literal}
		} else {
			p.addError(fmt.Sprintf("no prefix parse function for %s", p.curToken.Type))
			return nil
		}
	}
	
	// Parse infix
	for !p.peekTokenIs(TOKEN_SEMICOLON) && precedence < p.peekPrecedence() {
		switch p.peekToken.Type {
		case TOKEN_PLUS, TOKEN_MINUS, TOKEN_STAR, TOKEN_SLASH, TOKEN_PERCENT,
			TOKEN_EQ, TOKEN_NE, TOKEN_LT, TOKEN_GT, TOKEN_LE, TOKEN_GE,
			TOKEN_AND, TOKEN_OR, TOKEN_PIPE, TOKEN_AMP, TOKEN_ASSIGN:
			p.nextToken()
			leftExp = p.parseInfixExpression(leftExp)
		case TOKEN_LPAREN:
			p.nextToken()
			leftExp = p.parseCallExpression(leftExp)
		default:
			return leftExp
		}
	}
	
	return leftExp
}

// parsePrefixExpression parses prefix operators
func (p *Parser) parsePrefixExpression() Expression {
	expression := &PrefixExpression{
		Token:    p.curToken,
		Operator: p.curToken.Literal,
	}
	
	p.nextToken()
	expression.Right = p.parseExpression(PREFIX)
	
	return expression
}

// parseInfixExpression parses infix operators
func (p *Parser) parseInfixExpression(left Expression) Expression {
	expression := &InfixExpression{
		Token:    p.curToken,
		Operator: p.curToken.Literal,
		Left:     left,
	}
	
	precedence := p.curPrecedence()
	p.nextToken()
	expression.Right = p.parseExpression(precedence)
	
	return expression
}

// parseGroupedExpression parses (expr)
func (p *Parser) parseGroupedExpression() Expression {
	p.nextToken()
	exp := p.parseExpression(LOWEST)
	
	if !p.expectPeek(TOKEN_RPAREN) {
		return nil
	}
	
	return exp
}

// parseBracketExpression parses [expr]
func (p *Parser) parseBracketExpression() Expression {
	exp := &BracketExpression{
		Token:       p.curToken,
		BracketType: "[]",
	}
	
	p.nextToken()
	exp.Expression = p.parseExpression(LOWEST)
	
	if !p.expectPeek(TOKEN_RBRACKET) {
		return nil
	}
	
	return exp
}

// parseAngleBracketExpression parses <expr>
func (p *Parser) parseAngleBracketExpression() Expression {
	exp := &BracketExpression{
		Token:       p.curToken,
		BracketType: "<>",
	}
	
	p.nextToken()
	exp.Expression = p.parseExpression(LOWEST)
	
	if !p.expectPeek(TOKEN_GT) {
		return nil
	}
	
	return exp
}

// parseCallExpression parses function(args)
func (p *Parser) parseCallExpression(function Expression) Expression {
	exp := &CallExpression{
		Token:    p.curToken,
		Function: function,
	}
	exp.Arguments = p.parseCallArguments()
	return exp
}

// parseCallArguments parses function call arguments
func (p *Parser) parseCallArguments() []Expression {
	args := []Expression{}
	
	if p.peekTokenIs(TOKEN_RPAREN) {
		p.nextToken()
		return args
	}
	
	p.nextToken()
	args = append(args, p.parseExpression(LOWEST))
	
	for p.peekTokenIs(TOKEN_COMMA) {
		p.nextToken() // skip comma
		p.nextToken() // get arg
		args = append(args, p.parseExpression(LOWEST))
	}
	
	if !p.expectPeek(TOKEN_RPAREN) {
		return nil
	}
	
	return args
}

// isCommand checks if token type is a command
func (p *Parser) isCommand(t TokenType) bool {
	commands := []TokenType{
		TOKEN_MOVE, TOKEN_TURN, TOKEN_SPIN, TOKEN_STOP_SPIN,
		TOKEN_SHOW, TOKEN_HIDE, TOKEN_CACHE, TOKEN_DONT_CACHE,
		TOKEN_SHADE, TOKEN_DONT_SHADE, TOKEN_EMIT_SFX, TOKEN_EXPLODE,
		TOKEN_SLEEP, TOKEN_WAIT_FOR_TURN, TOKEN_WAIT_FOR_MOVE,
		TOKEN_CALL_SCRIPT, TOKEN_START_SCRIPT, TOKEN_SIGNAL,
		TOKEN_SET_SIGNAL_MASK, TOKEN_GET, TOKEN_SET,
		TOKEN_ATTACH_UNIT, TOKEN_DROP_UNIT,
	}
	
	for _, cmd := range commands {
		if t == cmd {
			return true
		}
	}
	return false
}

// isKeywordExpression checks if token can be a keyword expression
func (p *Parser) isKeywordExpression(t TokenType) bool {
	keywords := []TokenType{
		TOKEN_TO, TOKEN_ALONG, TOKEN_AROUND, TOKEN_SPEED,
		TOKEN_NOW, TOKEN_ACCELERATE, TOKEN_DECELERATE,
		TOKEN_FROM, TOKEN_TYPE,
	}
	
	for _, kw := range keywords {
		if t == kw {
			return true
		}
	}
	return false
}

// ParseNumber attempts to parse a number from a string
func ParseNumber(s string) (float64, error) {
	return strconv.ParseFloat(s, 64)
}
