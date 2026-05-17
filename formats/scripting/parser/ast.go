package parser

import (
	"fmt"
	"strings"
)

// Node is the base interface for all AST nodes
type Node interface {
	String() string
	TokenLiteral() string
}

// Statement represents a statement node
type Statement interface {
	Node
	statementNode()
}

// Expression represents an expression node
type Expression interface {
	Node
	expressionNode()
}

// Program is the root node of the AST
type Program struct {
	Statements []Statement
}

func (p *Program) String() string {
	var out strings.Builder
	for _, s := range p.Statements {
		if s != nil {
			out.WriteString(s.String())
		}
	}
	return out.String()
}

func (p *Program) TokenLiteral() string {
	if len(p.Statements) > 0 {
		return p.Statements[0].TokenLiteral()
	}
	return ""
}

// PieceDeclaration represents: piece base, turret, barrel;
type PieceDeclaration struct {
	Token Token // TOKEN_PIECE
	Names []string
}

func (pd *PieceDeclaration) statementNode()       {}
func (pd *PieceDeclaration) TokenLiteral() string { return pd.Token.Literal }
func (pd *PieceDeclaration) String() string {
	return fmt.Sprintf("piece %s;\n", strings.Join(pd.Names, ", "))
}

// StaticVarDeclaration represents: static-var x, y, z;
type StaticVarDeclaration struct {
	Token Token // TOKEN_STATIC_VAR
	Names []string
}

func (sv *StaticVarDeclaration) statementNode()       {}
func (sv *StaticVarDeclaration) TokenLiteral() string { return sv.Token.Literal }
func (sv *StaticVarDeclaration) String() string {
	return fmt.Sprintf("static-var %s;\n", strings.Join(sv.Names, ", "))
}

// FunctionDeclaration represents a function definition
type FunctionDeclaration struct {
	Token      Token // function name token
	Name       string
	Parameters []string
	Body       *BlockStatement
}

func (fd *FunctionDeclaration) statementNode()       {}
func (fd *FunctionDeclaration) TokenLiteral() string { return fd.Token.Literal }
func (fd *FunctionDeclaration) String() string {
	var out strings.Builder
	out.WriteString(fd.Name)
	out.WriteString("(")
	out.WriteString(strings.Join(fd.Parameters, ", "))
	out.WriteString(")\n")
	out.WriteString(fd.Body.String())
	return out.String()
}

// BlockStatement represents { ... }
type BlockStatement struct {
	Token      Token // TOKEN_LBRACE
	Statements []Statement
}

func (bs *BlockStatement) statementNode()       {}
func (bs *BlockStatement) TokenLiteral() string { return bs.Token.Literal }
func (bs *BlockStatement) String() string {
	var out strings.Builder
	out.WriteString("\t{\n")
	for _, s := range bs.Statements {
		if s == nil {
			continue
		}
		// Indent each statement
		lines := strings.Split(s.String(), "\n")
		for _, line := range lines {
			if line != "" {
				out.WriteString("\t")
				out.WriteString(line)
				out.WriteString("\n")
			}
		}
	}
	out.WriteString("\t}\n")
	return out.String()
}

// ExpressionStatement wraps an expression as a statement
type ExpressionStatement struct {
	Token      Token
	Expression Expression
}

func (es *ExpressionStatement) statementNode()       {}
func (es *ExpressionStatement) TokenLiteral() string { return es.Token.Literal }
func (es *ExpressionStatement) String() string {
	if es.Expression != nil {
		return es.Expression.String() + ";\n"
	}
	return ""
}

// ReturnStatement represents: return (expr);
type ReturnStatement struct {
	Token       Token // TOKEN_RETURN
	ReturnValue Expression
}

func (rs *ReturnStatement) statementNode()       {}
func (rs *ReturnStatement) TokenLiteral() string { return rs.Token.Literal }
func (rs *ReturnStatement) String() string {
	var out strings.Builder
	out.WriteString("return")
	if rs.ReturnValue != nil {
		out.WriteString(" (")
		out.WriteString(rs.ReturnValue.String())
		out.WriteString(")")
	}
	out.WriteString(";\n")
	return out.String()
}

// IfStatement represents: if (condition) { ... } else { ... }
type IfStatement struct {
	Token       Token // TOKEN_IF
	Condition   Expression
	Consequence *BlockStatement
	Alternative *BlockStatement
}

func (is *IfStatement) statementNode()       {}
func (is *IfStatement) TokenLiteral() string { return is.Token.Literal }
func (is *IfStatement) String() string {
	var out strings.Builder
	out.WriteString("if (")
	if is.Condition != nil {
		out.WriteString(is.Condition.String())
	}
	out.WriteString(")\n")
	if is.Consequence != nil {
		out.WriteString(is.Consequence.String())
	}
	if is.Alternative != nil {
		out.WriteString("\telse\n")
		out.WriteString(is.Alternative.String())
	}
	return out.String()
}

// WhileStatement represents: while (condition) { ... }
type WhileStatement struct {
	Token     Token // TOKEN_WHILE
	Condition Expression
	Body      *BlockStatement
}

func (ws *WhileStatement) statementNode()       {}
func (ws *WhileStatement) TokenLiteral() string { return ws.Token.Literal }
func (ws *WhileStatement) String() string {
	var out strings.Builder
	out.WriteString("while (")
	if ws.Condition != nil {
		out.WriteString(ws.Condition.String())
	}
	out.WriteString(")\n")
	if ws.Body != nil {
		out.WriteString(ws.Body.String())
	}
	return out.String()
}

// CommandStatement represents BOS commands (move, turn, show, etc.)
type CommandStatement struct {
	Token   Token // command token
	Command string
	Args    []Expression
}

func (cs *CommandStatement) statementNode()       {}
func (cs *CommandStatement) TokenLiteral() string { return cs.Token.Literal }
func (cs *CommandStatement) String() string {
	var out strings.Builder
	out.WriteString(cs.Command)
	for _, arg := range cs.Args {
		out.WriteString(" ")
		out.WriteString(arg.String())
	}
	out.WriteString(";\n")
	return out.String()
}

// Identifier represents a variable or piece name
type Identifier struct {
	Token Token
	Value string
}

func (i *Identifier) expressionNode()      {}
func (i *Identifier) TokenLiteral() string { return i.Token.Literal }
func (i *Identifier) String() string       { return i.Value }

// NumberLiteral represents a numeric value
type NumberLiteral struct {
	Token Token
	Value string
}

func (nl *NumberLiteral) expressionNode()      {}
func (nl *NumberLiteral) TokenLiteral() string { return nl.Token.Literal }
func (nl *NumberLiteral) String() string       { return nl.Value }

// StringLiteral represents a string value
type StringLiteral struct {
	Token Token
	Value string
}

func (sl *StringLiteral) expressionNode()      {}
func (sl *StringLiteral) TokenLiteral() string { return sl.Token.Literal }
func (sl *StringLiteral) String() string       { return fmt.Sprintf("\"%s\"", sl.Value) }

// InfixExpression represents binary operations: x + y, x == y, etc.
type InfixExpression struct {
	Token    Token
	Left     Expression
	Operator string
	Right    Expression
}

func (ie *InfixExpression) expressionNode()      {}
func (ie *InfixExpression) TokenLiteral() string { return ie.Token.Literal }
func (ie *InfixExpression) String() string {
	return fmt.Sprintf("(%s %s %s)", ie.Left.String(), ie.Operator, ie.Right.String())
}

// PrefixExpression represents unary operations: -x, !x
type PrefixExpression struct {
	Token    Token
	Operator string
	Right    Expression
}

func (pe *PrefixExpression) expressionNode()      {}
func (pe *PrefixExpression) TokenLiteral() string { return pe.Token.Literal }
func (pe *PrefixExpression) String() string {
	return fmt.Sprintf("(%s%s)", pe.Operator, pe.Right.String())
}

// CallExpression represents function calls: func(arg1, arg2)
type CallExpression struct {
	Token     Token // function name or (
	Function  Expression
	Arguments []Expression
}

func (ce *CallExpression) expressionNode()      {}
func (ce *CallExpression) TokenLiteral() string { return ce.Token.Literal }
func (ce *CallExpression) String() string {
	var args []string
	for _, a := range ce.Arguments {
		args = append(args, a.String())
	}
	return fmt.Sprintf("%s(%s)", ce.Function.String(), strings.Join(args, ", "))
}

// BracketExpression represents [expr] or <expr>
type BracketExpression struct {
	Token      Token // [ or <
	Expression Expression
	BracketType string // "[]" or "<>"
}

func (be *BracketExpression) expressionNode()      {}
func (be *BracketExpression) TokenLiteral() string { return be.Token.Literal }
func (be *BracketExpression) String() string {
	if be.BracketType == "[]" {
		return fmt.Sprintf("[%s]", be.Expression.String())
	}
	return fmt.Sprintf("<%s>", be.Expression.String())
}

// AxisExpression represents axis keywords: x-axis, y-axis, z-axis
type AxisExpression struct {
	Token Token
	Axis  string
}

func (ae *AxisExpression) expressionNode()      {}
func (ae *AxisExpression) TokenLiteral() string { return ae.Token.Literal }
func (ae *AxisExpression) String() string       { return ae.Axis }

// KeywordExpression represents special keywords as expressions
type KeywordExpression struct {
	Token   Token
	Keyword string
}

func (ke *KeywordExpression) expressionNode()      {}
func (ke *KeywordExpression) TokenLiteral() string { return ke.Token.Literal }
func (ke *KeywordExpression) String() string       { return ke.Keyword }
