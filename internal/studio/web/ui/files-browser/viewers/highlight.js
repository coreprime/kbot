// highlight.js
//
// Two syntax highlighters for the script formats:
//   - BosHighlighter  : BOS / decompiled-COB source with code folding,
//                       clickable #include links, and per-line lint
//                       annotations.
//   - CobaHighlighter : COB-assembly disassembly with collapsible script
//                       sections and interactive control-flow jump arrows.
//
// Both tokenise to HTML strings and render them through
// dangerouslySetInnerHTML; folding/lane state lives in the Preact tree so
// only the interactive chrome re-renders.

import { htm as html } from '@kbot/ui/htm-bind'
import { useState, useMemo, useCallback } from 'preact/hooks'

// ── shared helpers ──────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sevRank(s) {
  switch (s) { case 'error': return 3; case 'warning': return 2; case 'info': return 1; default: return 0 }
}
function highestSeverity(diags) {
  let best = 'info'
  for (const d of diags) if (sevRank(d.severity) > sevRank(best)) best = d.severity
  return best
}
function lintIcon(severity) {
  switch (severity) { case 'error': return '❌'; case 'warning': return '⚠️'; case 'info': return 'ℹ️'; default: return '' }
}

// ── BOS / decompiled-COB highlighter ────────────────────────────────

const BOS_KEYWORDS = new Set([
  'piece', 'static-var', 'if', 'else', 'while', 'return',
  'sleep', 'move', 'turn', 'spin', 'stop-spin', 'wait-for-turn', 'wait-for-move',
  'show', 'hide', 'explode', 'emit-sfx', 'cache', 'dont-cache', 'dont-shade',
  'signal', 'set-signal-mask', 'set', 'start-script', 'call-script', 'attach-unit', 'drop-unit',
])
const BOS_BUILTINS = new Set(['get', 'rand'])
const BOS_MODIFIERS = new Set(['now', 'speed', 'accelerate', 'decelerate', 'to', 'around'])
const BOS_AXES = new Set(['x-axis', 'y-axis', 'z-axis'])

function bspan(cls, content) { return `<span class="bos-${cls}">${content}</span>` }

function bosTokens(text) {
  const pattern = /(<\d+>)|(\d+)|([a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z_][a-zA-Z0-9_]*)*)|([{}();,=!<>+\-*/%|&]+)|(\s+)/g
  let result = '', lastIndex = 0, m
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) result += esc(text.slice(lastIndex, m.index))
    lastIndex = m.index + m[0].length
    const token = m[0]
    if (m[1]) { result += bspan('angle-num', esc(token)); continue }
    if (m[2]) { result += bspan('number', esc(token)); continue }
    if (m[3]) {
      const lower = token.toLowerCase()
      if (BOS_KEYWORDS.has(lower)) { result += bspan('keyword', esc(token)); continue }
      if (BOS_BUILTINS.has(lower)) { result += bspan('builtin', esc(token)); continue }
      if (BOS_MODIFIERS.has(lower)) { result += bspan('modifier', esc(token)); continue }
      if (BOS_AXES.has(lower)) { result += bspan('axis', esc(token)); continue }
      result += bspan(text[lastIndex] === '(' ? 'fn-name' : 'ident', esc(token))
      continue
    }
    if (m[4]) { result += bspan('punct', esc(token)); continue }
    if (m[5]) { result += token; continue }
    result += esc(token)
  }
  if (lastIndex < text.length) result += esc(text.slice(lastIndex))
  return result
}

function bosLineHTML(line, basePath) {
  const leadMatch = line.match(/^(\s*)(.*)$/)
  if (!leadMatch) return esc(line)
  const indent = leadMatch[1]
  let rest = leadMatch[2]

  if (rest.startsWith('#')) {
    const incMatch = rest.match(/^(#include\s+)"([^"]+)"(.*)$/)
    if (incMatch && basePath !== undefined) {
      const directive = incMatch[1], filename = incMatch[2], trailing = incMatch[3]
      const dir = basePath.replace(/\/[^/]*$/, '') || ''
      const target = dir ? `${dir}/${filename}` : filename
      return indent + bspan('preprocessor', esc(directive)) +
        '"<a class="bos-include-link" data-path="' + esc(target) + '">' + esc(filename) + '</a>"' +
        (trailing ? bspan('preprocessor', esc(trailing)) : '')
    }
    return indent + bspan('preprocessor', esc(rest))
  }
  if (rest.startsWith('//')) return indent + bspan('comment', esc(rest))

  let comment = ''
  const commentIdx = rest.indexOf('//')
  if (commentIdx >= 0) { comment = rest.slice(commentIdx); rest = rest.slice(0, commentIdx) }
  return indent + bosTokens(rest) + (comment ? bspan('comment', esc(comment)) : '')
}

function isFoldHeader(trimmed) {
  if (!trimmed) return false
  if (/^\w+\s*\(/.test(trimmed)) return true
  if (/^(if|else\s*if|else|while)\b/.test(trimmed)) return true
  return false
}

function extractSummary(trimmed) {
  const fnMatch = trimmed.match(/^(\w+)\s*\(/)
  if (fnMatch) return `${fnMatch[1]}(…)`
  if (trimmed.startsWith('else if')) return 'else if (…)'
  if (trimmed.startsWith('if')) return 'if (…)'
  if (trimmed.startsWith('else')) return 'else'
  if (trimmed.startsWith('while')) return 'while (…)'
  return trimmed.slice(0, 20) + '…'
}

function parseBosBlocks(code, basePath) {
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let pos = 0, lineNum = 0
  const next = () => ++lineNum

  function parse(depth) {
    const nodes = []
    while (pos < lines.length) {
      const line = lines[pos]
      const trimmed = line.trimStart()
      if (trimmed.startsWith('}') && depth > 0) return nodes
      const nextRaw = pos + 1 < lines.length ? lines[pos + 1].trimStart() : ''

      if (nextRaw === '{' && isFoldHeader(trimmed)) {
        const headerLine = next(), headerHtml = bosLineHTML(line, basePath), summary = extractSummary(trimmed)
        pos++
        const braceLine = next(), braceHtml = bosLineHTML(lines[pos], basePath)
        pos++
        const children = parse(depth + 1)
        const closeLine = pos < lines.length ? next() : 0
        const closeHtml = pos < lines.length ? bosLineHTML(lines[pos], basePath) : ''
        pos++
        nodes.push({ kind: 'fold', headerHtml, braceHtml, children, closeHtml, summary, headerLine, braceLine, closeLine })
        continue
      }
      if (trimmed.endsWith('{') && trimmed !== '{' && isFoldHeader(trimmed.slice(0, -1).trim())) {
        const headerLine = next(), headerHtml = bosLineHTML(line, basePath), summary = extractSummary(trimmed.slice(0, -1).trim())
        pos++
        const children = parse(depth + 1)
        const closeLine = pos < lines.length ? next() : 0
        const closeHtml = pos < lines.length ? bosLineHTML(lines[pos], basePath) : ''
        pos++
        nodes.push({ kind: 'fold', headerHtml, braceHtml: '', children, closeHtml, summary, headerLine, braceLine: 0, closeLine })
        continue
      }
      const ln = next()
      nodes.push({ kind: 'line', html: bosLineHTML(line, basePath), lineNum: ln })
      pos++
    }
    return nodes
  }
  return parse(0)
}

function BosLine({ lineNum, lineHtml, lintLines, highlightLine }) {
  const diags = lintLines && lintLines.get(lineNum)
  const topSev = diags ? highestSeverity(diags) : null
  const hl = highlightLine === lineNum
  return html`
    <span class=${'bos-line' + (topSev ? ` bos-line-${topSev}` : '') + (hl ? ' bos-line-highlight' : '')} data-line=${lineNum}>
      <span dangerouslySetInnerHTML=${{ __html: lineHtml + '\n' }}></span>
    </span>
    ${diags && diags.length ? html`<span class="bos-lint-annotations">${diags.map((d, i) => html`
      <span key=${i} class=${`bos-lint-msg bos-lint-msg-${d.severity}`}>${lintIcon(d.severity)} <span class="bos-lint-rule">${d.rule}</span> ${d.message}${'\n'}</span>
    `)}</span>` : null}
  `
}

function BosFold({ node, lintLines, highlightLine }) {
  const [collapsed, setCollapsed] = useState(false)
  const toggle = useCallback(() => setCollapsed((c) => !c), [])
  if (collapsed) {
    return html`
      <span data-line=${node.headerLine}>
        <span class="bos-fold-toggle" onClick=${toggle} title="Expand">▸ </span>
        <span class="bos-fold-header collapsed" onClick=${toggle} dangerouslySetInnerHTML=${{ __html: node.headerHtml }}></span>
        <span class="bos-fold-summary" onClick=${toggle}> ${`{ /* ${node.summary} */ }`}${'\n'}</span>
      </span>
    `
  }
  const headerDiags = lintLines && lintLines.get(node.headerLine)
  const headerSev = headerDiags ? highestSeverity(headerDiags) : null
  const headerHL = highlightLine === node.headerLine
  return html`
    <span class=${'bos-line' + (headerSev ? ` bos-line-${headerSev}` : '') + (headerHL ? ' bos-line-highlight' : '')} data-line=${node.headerLine}>
      <span class="bos-fold-toggle" onClick=${toggle} title="Collapse">▾ </span>
      <span dangerouslySetInnerHTML=${{ __html: node.headerHtml + '\n' }}></span>
    </span>
    ${node.braceHtml ? html`<${BosLine} lineNum=${node.braceLine} lineHtml=${node.braceHtml} lintLines=${lintLines} highlightLine=${highlightLine} />` : null}
    ${node.children.map((child, i) => html`<${BosBlock} key=${i} node=${child} lintLines=${lintLines} highlightLine=${highlightLine} />`)}
    <${BosLine} lineNum=${node.closeLine} lineHtml=${node.closeHtml} lintLines=${lintLines} highlightLine=${highlightLine} />
  `
}

function BosBlock({ node, lintLines, highlightLine }) {
  return node.kind === 'line'
    ? html`<${BosLine} lineNum=${node.lineNum} lineHtml=${node.html} lintLines=${lintLines} highlightLine=${highlightLine} />`
    : html`<${BosFold} node=${node} lintLines=${lintLines} highlightLine=${highlightLine} />`
}

export function BosHighlighter({ code, basePath, lintLines, highlightLine, onOpenFile }) {
  const tree = useMemo(() => parseBosBlocks(code || '', basePath), [code, basePath])
  // Delegate #include link clicks to the host's file-open callback.
  const onClick = useCallback((e) => {
    const a = e.target.closest && e.target.closest('.bos-include-link')
    if (a && onOpenFile) { e.preventDefault(); onOpenFile(a.getAttribute('data-path')) }
  }, [onOpenFile])
  return html`
    <pre class="fx-code bos-highlight" onClick=${onClick}>${tree.map((node, i) => html`<${BosBlock} key=${i} node=${node} lintLines=${lintLines} highlightLine=${highlightLine} />`)}</pre>
  `
}

// ── COB-assembly highlighter ────────────────────────────────────────

const FLOW_SET = new Set(['JUMP', 'JUMP_IF_FALSE', 'RETURN', 'CALL_SCRIPT', 'START_SCRIPT'])
const STACK_SET = new Set(['PUSH_CONST', 'PUSH_LOCAL', 'PUSH_STATIC', 'POP_LOCAL', 'POP_STATIC', 'STACK_ALLOC', 'PUSH_CONSTANT', 'PUSH_LOCAL_VAR', 'POP_LOCAL_VAR'])
const ANIM_SET = new Set(['MOVE', 'MOVE_NOW', 'TURN', 'TURN_NOW', 'SPIN', 'STOP_SPIN', 'WAIT_FOR_TURN', 'WAIT_FOR_MOVE', 'SHOW', 'HIDE', 'CACHE', 'DONT_CACHE', 'DONT_SHADE', 'SHADE'])
const ARITH_SET = new Set(['ADD', 'SUB', 'MUL', 'DIV', 'BITWISE_AND', 'BITWISE_OR', 'BITWISE_XOR', 'BITWISE_NOT', 'LOGICAL_AND', 'LOGICAL_OR', 'LOGICAL_NOT', 'LESS_THAN', 'LESS_OR_EQUAL', 'GREATER_THAN', 'GREATER_OR_EQUAL', 'GREATER_EQUAL', 'EQUAL', 'NOT_EQUAL', 'RAND'])

function cspan(cls, content) { return `<span class="coba-${cls}">${content}</span>` }

function highlightDirective(line) {
  const trimmed = line.trim()
  if (trimmed === '') return ''
  const m = trimmed.match(/^(\.(version|statics|piece|script))\s+(.*)$/)
  if (m) {
    if (m[1] === '.script') return cspan('directive', esc(m[1])) + ' ' + cspan('script-name', esc(m[3]))
    return cspan('directive', esc(m[1])) + ' ' + cspan('directive-arg', esc(m[3]))
  }
  if (trimmed.startsWith(';')) return cspan('comment', esc(line))
  return esc(line)
}

function highlightOperands(text) {
  if (!text.trim()) return esc(text)
  let result = '', lastIdx = 0, m
  const re = /-?\d+/g
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) result += esc(text.slice(lastIdx, m.index))
    result += cspan('operand', esc(m[0]))
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) result += esc(text.slice(lastIdx))
  return result
}

function highlightInstr(line) {
  const trimmed = line.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith(';')) return cspan('comment', esc(line))
  const m = trimmed.match(/^([0-9A-Fa-f]{4})\s+([A-Z_][A-Z_0-9]+)(.*)$/)
  if (!m) return esc(line)
  const offset = m[1], opcode = m[2], rest = m[3]
  let operandPart = rest, commentPart = ''
  const ci = rest.indexOf(';')
  if (ci >= 0) { operandPart = rest.slice(0, ci); commentPart = rest.slice(ci) }
  let opCls = 'op-effect'
  if (FLOW_SET.has(opcode)) opCls = 'op-flow'
  else if (STACK_SET.has(opcode)) opCls = 'op-stack'
  else if (ANIM_SET.has(opcode)) opCls = 'op-anim'
  else if (ARITH_SET.has(opcode)) opCls = 'op-arith'
  return cspan('offset', esc(offset)) + '  ' + cspan(opCls, esc(opcode)) + highlightOperands(operandPart) +
    (commentPart ? cspan('comment', esc(commentPart)) : '')
}

function parseCobaSections(code) {
  const rawLines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const sections = []
  let header = [], body = [], scriptName = null

  const flush = () => {
    if (body.length > 0) {
      const jumps = computeJumps(body)
      const maxLane = jumps.reduce((m, j) => Math.max(m, j.lane), -1)
      sections.push({ headerLines: header, lines: body, jumps, maxLane, scriptName })
    } else if (header.length > 0) {
      sections.push({ headerLines: header, lines: [], jumps: [], maxLane: -1, scriptName })
    }
    header = []; body = []; scriptName = null
  }

  for (const raw of rawLines) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('.script ')) { flush(); header = [raw]; scriptName = trimmed.replace('.script ', ''); continue }
    if (trimmed.startsWith('.') || trimmed === '') {
      if (body.length === 0) header.push(raw)
      else { flush(); header.push(raw) }
      continue
    }
    const m = trimmed.match(/^([0-9A-Fa-f]{4})\s+([A-Z_][A-Z_0-9]+)(.*)$/)
    if (!m) {
      if (body.length === 0) header.push(raw)
      else body.push({ raw, offset: null, isJump: false, jumpTarget: null, isLoop: false })
      continue
    }
    const offset = m[1], opcode = m[2], rest = m[3]
    const isJump = opcode === 'JUMP' || opcode === 'JUMP_IF_FALSE'
    let jumpTarget = null, isLoop = false
    if (isJump) {
      const tm = rest.match(/;\s*->\s*0x([0-9A-Fa-f]+)/)
      if (tm) jumpTarget = tm[1].toUpperCase()
      if (rest.includes('(loop)')) isLoop = true
    }
    body.push({ raw, offset: offset.toUpperCase(), isJump, jumpTarget, isLoop })
  }
  flush()
  return sections
}

function computeJumps(lines) {
  const offsetMap = new Map()
  lines.forEach((l, i) => { if (l.offset) offsetMap.set(l.offset, i) })
  const rawJumps = []
  lines.forEach((l, i) => {
    if (l.isJump && l.jumpTarget) {
      const toIdx = offsetMap.get(l.jumpTarget)
      if (toIdx !== undefined) rawJumps.push({ fromIdx: i, toIdx, isLoop: l.isLoop })
    }
  })
  const sorted = [...rawJumps].sort((a, b) => Math.abs(a.toIdx - a.fromIdx) - Math.abs(b.toIdx - b.fromIdx))
  const jumps = [], laneEnds = []
  for (const j of sorted) {
    const top = Math.min(j.fromIdx, j.toIdx), bot = Math.max(j.fromIdx, j.toIdx)
    let lane = 0
    while (lane < laneEnds.length) { if (laneEnds[lane] < top) break; lane++ }
    if (lane >= laneEnds.length) laneEnds.push(-1)
    laneEnds[lane] = bot
    jumps.push({ ...j, lane })
  }
  return jumps
}

function arrowHead(x, y) { return `${x},${y} ${x - 5},${y - 3} ${x - 5},${y + 3}` }

function JumpArrow({ jump, index, lineHeight, laneWidth, active, onEnter, onLeave }) {
  const fromY = jump.fromIdx * lineHeight + lineHeight / 2
  const toY = jump.toIdx * lineHeight + lineHeight / 2
  const x = (jump.lane + 1) * laneWidth
  const right = (jump.lane + 1) * laneWidth + 6
  const r = 4
  const d = fromY < toY
    ? `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY + r} V ${toY - r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
    : `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY - r} V ${toY + r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
  const color = active ? '#ffcb6b' : jump.isLoop ? '#c792ea' : '#546e7a'
  return html`
    <g style="pointer-events:stroke;cursor:pointer" onMouseEnter=${() => onEnter(index)} onMouseLeave=${onLeave}>
      <path d=${d} fill="none" stroke=${color} stroke-width=${active ? 2 : 1.2} opacity=${active ? 1 : 0.6} />
      <polygon points=${arrowHead(right, toY)} fill=${color} opacity=${active ? 1 : 0.6} />
    </g>
  `
}

function CobaSection({ section }) {
  const [hoverJump, setHoverJump] = useState(null)
  const [collapsed, setCollapsed] = useState(false)
  const isCollapsible = section.scriptName !== null && section.lines.length > 0
  const lineHeight = 20, laneWidth = 14
  const gutterWidth = (section.maxLane + 1) * laneWidth + 8

  const activeJump = hoverJump !== null ? section.jumps[hoverJump] : null
  const highlightLines = new Set()
  if (activeJump) { highlightLines.add(activeJump.fromIdx); highlightLines.add(activeJump.toIdx) }

  const lineToJumps = useMemo(() => {
    const map = new Map()
    section.jumps.forEach((j, ji) => { if (!map.has(j.fromIdx)) map.set(j.fromIdx, []); map.get(j.fromIdx).push(ji) })
    return map
  }, [section.jumps])

  const onLineEnter = useCallback((i) => { const jis = lineToJumps.get(i); if (jis && jis.length) setHoverJump(jis[0]) }, [lineToJumps])
  const onLineLeave = useCallback(() => setHoverJump(null), [])

  if (section.lines.length === 0) {
    return html`<div class="coba-section">${section.headerLines.map((l, i) => html`<div key=${i} class="coba-line" dangerouslySetInnerHTML=${{ __html: highlightDirective(l) + '\n' }}></div>`)}</div>`
  }

  const preambleHeaders = section.headerLines.filter((l) => !l.trim().startsWith('.script '))
  const scriptHeader = section.headerLines.find((l) => l.trim().startsWith('.script '))

  return html`
    <div class="coba-section">
      ${preambleHeaders.map((l, i) => html`<div key=${i} class="coba-line" dangerouslySetInnerHTML=${{ __html: highlightDirective(l) + '\n' }}></div>`)}
      ${scriptHeader ? html`
        <div class=${'coba-line coba-script-header' + (isCollapsible ? ' coba-clickable' : '')}
             onClick=${isCollapsible ? () => setCollapsed((c) => !c) : undefined}>
          ${isCollapsible ? html`<span class="coba-fold-toggle">${collapsed ? '▸' : '▾'}</span>` : null}
          <span dangerouslySetInnerHTML=${{ __html: highlightDirective(scriptHeader) }}></span>
          ${collapsed ? html`<span class="coba-collapsed-summary"> (${section.lines.length} instructions)</span>` : null}
          ${'\n'}
        </div>` : null}
      ${!collapsed ? html`
        <div class="coba-script-body" style="position:relative">
          ${section.jumps.length ? html`
            <svg class="coba-arrows" style=${`position:absolute;left:0;top:0;width:${gutterWidth}px;height:${section.lines.length * lineHeight}px;pointer-events:none`}>
              ${section.jumps.map((j, ji) => html`<${JumpArrow} key=${ji} jump=${j} index=${ji} lineHeight=${lineHeight} laneWidth=${laneWidth}
                  active=${hoverJump === ji} onEnter=${setHoverJump} onLeave=${onLineLeave} />`)}
            </svg>` : null}
          <div style=${`padding-left:${section.maxLane >= 0 ? gutterWidth : 0}px`}>
            ${section.lines.map((line, i) => html`
              <div key=${i} class=${'coba-line' + (highlightLines.has(i) ? ' coba-line-active' : '') + (line.isJump ? ' coba-line-jump' : '')}
                   style=${`height:${lineHeight}px;line-height:${lineHeight}px`}
                   onMouseEnter=${line.isJump ? () => onLineEnter(i) : undefined}
                   onMouseLeave=${line.isJump ? onLineLeave : undefined}
                   dangerouslySetInnerHTML=${{ __html: highlightInstr(line.raw) }}></div>`)}
          </div>
        </div>` : null}
    </div>
  `
}

export function CobaHighlighter({ code }) {
  const sections = useMemo(() => parseCobaSections(code || ''), [code])
  return html`<div class="fx-code coba-highlight">${sections.map((sec, i) => html`<${CobaSection} key=${i} section=${sec} />`)}</div>`
}
