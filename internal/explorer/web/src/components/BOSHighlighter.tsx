import { useState, useMemo, useCallback } from 'react'
import type { LintLineInfo } from '../api'

// BOS/COB script language syntax highlighter with code folding.
// Used for both raw .bos files and decompiled COB output.

interface Props {
  code: string
  className?: string
  /** Directory path of the file, used to resolve #include links. */
  basePath?: string
  /** Map of 1-based line numbers to lint diagnostics. */
  lintLines?: Map<number, LintLineInfo[]>
  /** Line to highlight (1-based) when jumping from lint tab. */
  highlightLine?: number | null
}

export default function BOSHighlighter({ code, className, basePath, lintLines, highlightLine }: Props) {
  const tree = useMemo(() => parseBlocks(code, basePath), [code, basePath])

  return (
    <pre className={`code-block bos-highlight ${className || ''}`}>
      {tree.map((node, i) => (
        <BlockNode key={i} node={node} lintLines={lintLines} highlightLine={highlightLine} />
      ))}
    </pre>
  )
}

// ── block tree ─────────────────────────────────────────────────────────────

interface LineNode {
  kind: 'line'
  html: string
  lineNum: number      // 1-based source line number
}

interface FoldNode {
  kind: 'fold'
  headerHtml: string
  braceHtml: string
  children: BlockTree
  closeHtml: string
  summary: string
  headerLine: number   // 1-based line of the function/if header
  braceLine: number    // line of the { (0 if inline)
  closeLine: number    // line of the }
}

type BlockTree = (LineNode | FoldNode)[]

function parseBlocks(code: string, basePath?: string): BlockTree {
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let pos = 0
  let lineNum = 0 // 1-based line counter

  function nextLineNum(): number { return ++lineNum }

  function parse(depth: number): BlockTree {
    const nodes: BlockTree = []

    while (pos < lines.length) {
      const line = lines[pos]
      const trimmed = line.trimStart()

      if (trimmed.startsWith('}') && depth > 0) {
        return nodes
      }

      const nextRawLine = pos + 1 < lines.length ? lines[pos + 1].trimStart() : ''

      // Pattern: header on this line, "{" on the next
      if (nextRawLine === '{' && isFoldHeader(trimmed)) {
        const headerLine = nextLineNum()
        const headerHtml = highlightLine(line, basePath)
        const summary = extractSummary(trimmed)
        pos++
        const braceLine = nextLineNum()
        const braceHtml = highlightLine(lines[pos], basePath)
        pos++
        const children = parse(depth + 1)
        const closeLine = pos < lines.length ? nextLineNum() : 0
        const closeHtml = pos < lines.length ? highlightLine(lines[pos], basePath) : ''
        pos++
        nodes.push({ kind: 'fold', headerHtml, braceHtml, children, closeHtml, summary, headerLine, braceLine, closeLine })
        continue
      }

      // Pattern: line ends with { (inline brace)
      if (trimmed.endsWith('{') && trimmed !== '{' && isFoldHeader(trimmed.slice(0, -1).trim())) {
        const headerLine = nextLineNum()
        const headerHtml = highlightLine(line, basePath)
        const summary = extractSummary(trimmed.slice(0, -1).trim())
        pos++
        const children = parse(depth + 1)
        const closeLine = pos < lines.length ? nextLineNum() : 0
        const closeHtml = pos < lines.length ? highlightLine(lines[pos], basePath) : ''
        pos++
        nodes.push({ kind: 'fold', headerHtml, braceHtml: '', children, closeHtml, summary, headerLine, braceLine: 0, closeLine })
        continue
      }

      // Plain line
      const ln = nextLineNum()
      nodes.push({ kind: 'line', html: highlightLine(line, basePath), lineNum: ln })
      pos++
    }

    return nodes
  }

  return parse(0)
}

function isFoldHeader(trimmed: string): boolean {
  if (!trimmed) return false
  // Function declaration: "Name(params)"
  if (/^\w+\s*\(/.test(trimmed)) return true
  // Control flow: if, else, while, else if
  if (/^(if|else\s*if|else|while)\b/.test(trimmed)) return true
  return false
}

function extractSummary(trimmed: string): string {
  // "FuncName(params)" → "FuncName(…)"
  const fnMatch = trimmed.match(/^(\w+)\s*\(/)
  if (fnMatch) return `${fnMatch[1]}(…)`
  // "if (condition)" → "if (…)"
  if (trimmed.startsWith('if')) return 'if (…)'
  if (trimmed.startsWith('else if')) return 'else if (…)'
  if (trimmed.startsWith('else')) return 'else'
  if (trimmed.startsWith('while')) return 'while (…)'
  return trimmed.slice(0, 20) + '…'
}

// ── block renderer ─────────────────────────────────────────────────────────

interface RenderProps {
  lintLines?: Map<number, LintLineInfo[]>
  highlightLine?: number | null
}

function BlockNode({ node, lintLines, highlightLine }: { node: LineNode | FoldNode } & RenderProps) {
  if (node.kind === 'line') {
    return <LinePure lineNum={node.lineNum} html={node.html} lintLines={lintLines} highlightLine={highlightLine} />
  }
  return <FoldBlock node={node} lintLines={lintLines} highlightLine={highlightLine} />
}

function LinePure({ lineNum, html, lintLines, highlightLine }: { lineNum: number; html: string } & RenderProps) {
  const diags = lintLines?.get(lineNum)
  const topSeverity = diags ? highestSeverity(diags) : undefined
  const isHighlighted = highlightLine === lineNum

  return (
    <>
      <span
        className={`bos-line${topSeverity ? ` bos-line-${topSeverity}` : ''}${isHighlighted ? ' bos-line-highlight' : ''}`}
        data-line={lineNum}
      >
  
        <span dangerouslySetInnerHTML={{ __html: html + '\n' }} />
      </span>
      {diags && diags.length > 0 && (
        <span className="bos-lint-annotations">
          {diags.map((d, i) => (
            <span key={i} className={`bos-lint-msg bos-lint-msg-${d.severity}`}>
              {lintIcon(d.severity)} <span className="bos-lint-rule">{d.rule}</span> {d.message}
              {'\n'}
            </span>
          ))}
        </span>
      )}
    </>
  )
}

function FoldBlock({ node, lintLines, highlightLine }: { node: FoldNode } & RenderProps) {
  const [collapsed, setCollapsed] = useState(false)
  const toggle = useCallback(() => setCollapsed(c => !c), [])

  if (collapsed) {
    // Check if any lint issue falls in the collapsed range.
    const range = foldLineRange(node)
    let collapsedSeverity: string | undefined
    if (lintLines) {
      for (let l = range.start; l <= range.end; l++) {
        const diags = lintLines.get(l)
        if (diags) {
          const s = highestSeverity(diags)
          if (!collapsedSeverity || sevRank(s) > sevRank(collapsedSeverity)) {
            collapsedSeverity = s
          }
        }
      }
    }

    return (
      <span className={collapsedSeverity ? `bos-line-${collapsedSeverity}` : ''} data-line={node.headerLine}>
        {collapsedSeverity && <span className="bos-lint-icon">{lintIcon(collapsedSeverity)}</span>}
        <span className="bos-fold-toggle" onClick={toggle} title="Expand">▸ </span>
        <span className="bos-fold-header collapsed" onClick={toggle}
          dangerouslySetInnerHTML={{ __html: node.headerHtml }} />
        <span className="bos-fold-summary" onClick={toggle}>
          {' {'} {`/* ${node.summary} */`} {'}\n'}
        </span>
      </span>
    )
  }

  const headerDiags = lintLines?.get(node.headerLine)
  const headerSev = headerDiags ? highestSeverity(headerDiags) : undefined
  const headerHL = highlightLine === node.headerLine

  return (
    <>
      <span
        className={`bos-line${headerSev ? ` bos-line-${headerSev}` : ''}${headerHL ? ' bos-line-highlight' : ''}`}
        data-line={node.headerLine}
      >

        <span className="bos-fold-toggle" onClick={toggle} title="Collapse">▾ </span>
        <span dangerouslySetInnerHTML={{ __html: node.headerHtml + '\n' }} />
      </span>
      {headerDiags && headerDiags.length > 0 && (
        <span className="bos-lint-annotations">
          {headerDiags.map((d, i) => (
            <span key={i} className={`bos-lint-msg bos-lint-msg-${d.severity}`}>
              {lintIcon(d.severity)} <span className="bos-lint-rule">{d.rule}</span> {d.message}
              {'\n'}
            </span>
          ))}
        </span>
      )}
      {node.braceHtml && <LinePure lineNum={node.braceLine} html={node.braceHtml} lintLines={lintLines} highlightLine={highlightLine} />}
      {node.children.map((child, i) => (
        <BlockNode key={i} node={child} lintLines={lintLines} highlightLine={highlightLine} />
      ))}
      <LinePure lineNum={node.closeLine} html={node.closeHtml} lintLines={lintLines} highlightLine={highlightLine} />
    </>
  )
}

function foldLineRange(node: FoldNode): { start: number; end: number } {
  return { start: node.headerLine, end: node.closeLine || node.headerLine }
}

function highestSeverity(diags: LintLineInfo[]): string {
  let best = 'info'
  for (const d of diags) {
    if (sevRank(d.severity) > sevRank(best)) best = d.severity
  }
  return best
}

function lintIcon(severity: string): string {
  switch (severity) {
    case 'error': return '❌'
    case 'warning': return '⚠️'
    case 'info': return 'ℹ️'
    default: return ''
  }
}

function sevRank(s: string): number {
  switch (s) {
    case 'error': return 3
    case 'warning': return 2
    case 'info': return 1
    default: return 0
  }
}

// ── per-line syntax highlighter (unchanged) ────────────────────────────────

const KEYWORDS = new Set([
  'piece', 'static-var',
  'if', 'else', 'while', 'return',
  'sleep', 'move', 'turn', 'spin', 'stop-spin',
  'wait-for-turn', 'wait-for-move',
  'show', 'hide', 'explode', 'emit-sfx',
  'cache', 'dont-cache', 'dont-shade',
  'signal', 'set-signal-mask', 'set',
  'start-script', 'call-script',
  'attach-unit', 'drop-unit',
])

const BUILTIN_FNS = new Set(['get', 'rand'])
const MODIFIERS = new Set(['now', 'speed', 'accelerate', 'decelerate', 'to', 'around'])
const AXES = new Set(['x-axis', 'y-axis', 'z-axis'])

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function span(cls: string, content: string): string {
  return `<span class="bos-${cls}">${content}</span>`
}

function highlightLine(line: string, basePath?: string): string {
  const leadMatch = line.match(/^(\s*)(.*)$/)
  if (!leadMatch) return esc(line)
  const indent = leadMatch[1]
  let rest = leadMatch[2]

  if (rest.startsWith('#')) {
    // Make #include filenames clickable links.
    const incMatch = rest.match(/^(#include\s+)"([^"]+)"(.*)$/)
    if (incMatch && basePath !== undefined) {
      const [, directive, filename, trailing] = incMatch
      const dir = basePath.replace(/\/[^/]*$/, '') || basePath
      const target = dir ? `${dir}/${filename}` : filename
      return indent +
        span('preprocessor', esc(directive)) +
        '"<a class="bos-include-link" href="/#/view/' + esc(target) + '">' + esc(filename) + '</a>"' +
        (trailing ? span('preprocessor', esc(trailing)) : '')
    }
    return indent + span('preprocessor', esc(rest))
  }
  if (rest.startsWith('//')) return indent + span('comment', esc(rest))

  let comment = ''
  const commentIdx = rest.indexOf('//')
  if (commentIdx >= 0) {
    comment = rest.slice(commentIdx)
    rest = rest.slice(0, commentIdx)
  }

  return indent + highlightTokens(rest) + (comment ? span('comment', esc(comment)) : '')
}

function highlightTokens(text: string): string {
  const pattern = /(<\d+>)|(\d+)|([a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z_][a-zA-Z0-9_]*)*)|([{}();,=!<>+\-*/%|&]+)|(\s+)/g

  let result = ''
  let lastIndex = 0
  let m: RegExpExecArray | null

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) result += esc(text.slice(lastIndex, m.index))
    lastIndex = m.index + m[0].length
    const token = m[0]

    if (m[1]) { result += span('angle-num', esc(token)); continue }
    if (m[2]) { result += span('number', esc(token)); continue }
    if (m[3]) {
      const lower = token.toLowerCase()
      if (KEYWORDS.has(lower)) { result += span('keyword', esc(token)); continue }
      if (BUILTIN_FNS.has(lower)) { result += span('builtin', esc(token)); continue }
      if (MODIFIERS.has(lower)) { result += span('modifier', esc(token)); continue }
      if (AXES.has(lower)) { result += span('axis', esc(token)); continue }
      result += span(text[lastIndex] === '(' ? 'fn-name' : 'ident', esc(token))
      continue
    }
    if (m[4]) { result += span('punct', esc(token)); continue }
    if (m[5]) { result += token; continue }
    result += esc(token)
  }

  if (lastIndex < text.length) result += esc(text.slice(lastIndex))
  return result
}
