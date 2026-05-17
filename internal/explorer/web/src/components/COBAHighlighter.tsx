import { useState, useMemo, useCallback } from 'react'

// COB Assembly disassembly viewer with syntax highlighting and
// interactive control-flow jump arrows.

interface Props {
  code: string
  className?: string
}

export default function COBAHighlighter({ code, className }: Props) {
  const sections = useMemo(() => parseSections(code), [code])

  return (
    <div className={`code-block coba-highlight ${className || ''}`}>
      {sections.map((sec, i) => (
        <ScriptSection key={i} section={sec} />
      ))}
    </div>
  )
}

// ── data model ─────────────────────────────────────────────────────────────

interface ParsedLine {
  raw: string
  offset: string | null    // hex offset like "0008", or null for non-instructions
  opcode: string | null
  isJump: boolean
  jumpTarget: string | null // hex target like "007C"
  isLoop: boolean
}

interface Jump {
  fromIdx: number
  toIdx: number
  lane: number
  isLoop: boolean
}

interface Section {
  headerLines: string[]     // directives before first instruction
  lines: ParsedLine[]
  jumps: Jump[]
  maxLane: number
  scriptName: string | null // name from .script directive, null for preamble
}

// ── parser ─────────────────────────────────────────────────────────────────

function parseSections(code: string): Section[] {
  const rawLines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const sections: Section[] = []
  let currentHeader: string[] = []
  let currentLines: ParsedLine[] = []

  let currentScriptName: string | null = null

  const flushSection = () => {
    if (currentLines.length > 0) {
      const jumps = computeJumps(currentLines)
      const maxLane = jumps.reduce((m, j) => Math.max(m, j.lane), -1)
      sections.push({ headerLines: currentHeader, lines: currentLines, jumps, maxLane, scriptName: currentScriptName })
    } else if (currentHeader.length > 0) {
      sections.push({ headerLines: currentHeader, lines: [], jumps: [], maxLane: -1, scriptName: currentScriptName })
    }
    currentHeader = []
    currentLines = []
    currentScriptName = null
  }

  for (const raw of rawLines) {
    const trimmed = raw.trim()

    // .script starts a new section
    if (trimmed.startsWith('.script ')) {
      flushSection()
      currentHeader = [raw]
      currentScriptName = trimmed.replace('.script ', '')
      continue
    }

    // Other directives go to header
    if (trimmed.startsWith('.') || trimmed === '') {
      if (currentLines.length === 0) {
        currentHeader.push(raw)
      } else {
        // blank line after instructions — end section
        flushSection()
        currentHeader.push(raw)
      }
      continue
    }

    // Parse instruction
    const instrMatch = trimmed.match(/^([0-9A-Fa-f]{4})\s+([A-Z_][A-Z_0-9]+)(.*)$/)
    if (!instrMatch) {
      // Non-instruction line (comment, etc.)
      if (currentLines.length === 0) {
        currentHeader.push(raw)
      } else {
        currentLines.push({ raw, offset: null, opcode: null, isJump: false, jumpTarget: null, isLoop: false })
      }
      continue
    }

    const [, offset, opcode, rest] = instrMatch
    const isJump = opcode === 'JUMP' || opcode === 'JUMP_IF_FALSE'
    let jumpTarget: string | null = null
    let isLoop = false

    if (isJump) {
      const targetMatch = rest.match(/;\s*->\s*0x([0-9A-Fa-f]+)/)
      if (targetMatch) {
        jumpTarget = targetMatch[1].toUpperCase()
      }
      if (rest.includes('(loop)')) {
        isLoop = true
      }
    }

    currentLines.push({ raw, offset: offset.toUpperCase(), opcode, isJump, jumpTarget, isLoop })
  }

  flushSection()
  return sections
}

function computeJumps(lines: ParsedLine[]): Jump[] {
  // Build offset→index map
  const offsetMap = new Map<string, number>()
  lines.forEach((l, i) => {
    if (l.offset) offsetMap.set(l.offset, i)
  })

  // Collect jumps
  const rawJumps: { fromIdx: number; toIdx: number; isLoop: boolean }[] = []
  lines.forEach((l, i) => {
    if (l.isJump && l.jumpTarget) {
      const toIdx = offsetMap.get(l.jumpTarget)
      if (toIdx !== undefined) {
        rawJumps.push({ fromIdx: i, toIdx, isLoop: l.isLoop })
      }
    }
  })

  // Assign lanes (columns) — greedy interval scheduling sorted by span width
  const sorted = [...rawJumps].sort((a, b) => {
    const spanA = Math.abs(a.toIdx - a.fromIdx)
    const spanB = Math.abs(b.toIdx - b.fromIdx)
    return spanA - spanB
  })

  const jumps: Jump[] = []
  const laneEnds: number[] = [] // laneEnds[lane] = last row occupied

  for (const j of sorted) {
    const top = Math.min(j.fromIdx, j.toIdx)
    const bot = Math.max(j.fromIdx, j.toIdx)

    // Find first available lane
    let lane = 0
    while (lane < laneEnds.length) {
      if (laneEnds[lane] < top) break
      lane++
    }
    if (lane >= laneEnds.length) laneEnds.push(-1)
    laneEnds[lane] = bot

    jumps.push({ ...j, lane })
  }

  return jumps
}

// ── renderer ───────────────────────────────────────────────────────────────

function ScriptSection({ section }: { section: Section }) {
  const [hoverJump, setHoverJump] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const isCollapsible = section.scriptName !== null && section.lines.length > 0

  const lineHeight = 20
  const laneWidth = 14
  const gutterWidth = (section.maxLane + 1) * laneWidth + 8

  const activeJump = hoverJump !== null ? section.jumps[hoverJump] : null
  const highlightLines = new Set<number>()
  if (activeJump) {
    highlightLines.add(activeJump.fromIdx)
    highlightLines.add(activeJump.toIdx)
  }

  const lineToJumps = useMemo(() => {
    const map = new Map<number, number[]>()
    section.jumps.forEach((j, ji) => {
      if (!map.has(j.fromIdx)) map.set(j.fromIdx, [])
      map.get(j.fromIdx)!.push(ji)
    })
    return map
  }, [section.jumps])

  const onLineEnter = useCallback((lineIdx: number) => {
    const jis = lineToJumps.get(lineIdx)
    if (jis && jis.length > 0) setHoverJump(jis[0])
  }, [lineToJumps])

  const onLineLeave = useCallback(() => {
    setHoverJump(null)
  }, [])

  // Header-only section (directives without instructions).
  if (section.lines.length === 0) {
    return (
      <div className="coba-section">
        {section.headerLines.map((l, i) => (
          <div key={i} className="coba-line" dangerouslySetInnerHTML={{ __html: highlightDirective(l) + '\n' }} />
        ))}
      </div>
    )
  }

  // Render non-.script header lines normally.
  const preambleHeaders = section.headerLines.filter(l => !l.trim().startsWith('.script '))
  const scriptHeader = section.headerLines.find(l => l.trim().startsWith('.script '))

  return (
    <div className="coba-section">
      {preambleHeaders.map((l, i) => (
        <div key={i} className="coba-line" dangerouslySetInnerHTML={{ __html: highlightDirective(l) + '\n' }} />
      ))}

      {/* Collapsible .script header */}
      {scriptHeader && (
        <div
          className={`coba-line coba-script-header ${isCollapsible ? 'coba-clickable' : ''}`}
          onClick={isCollapsible ? () => setCollapsed(c => !c) : undefined}
        >
          {isCollapsible && (
            <span className="coba-fold-toggle">{collapsed ? '▸' : '▾'}</span>
          )}
          <span dangerouslySetInnerHTML={{ __html: highlightDirective(scriptHeader) }} />
          {collapsed && (
            <span className="coba-collapsed-summary">
              {' '}({section.lines.length} instructions)
            </span>
          )}
          {'\n'}
        </div>
      )}

      {/* Instruction body — hidden when collapsed */}
      {!collapsed && (
      <div className="coba-script-body" style={{ position: 'relative' }}>
        {/* SVG arrow overlay */}
        {section.jumps.length > 0 && (
          <svg
            className="coba-arrows"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: gutterWidth,
              height: section.lines.length * lineHeight,
              pointerEvents: 'none',
            }}
          >
            {section.jumps.map((j, ji) => (
              <JumpArrow
                key={ji}
                jump={j}
                index={ji}
                lineHeight={lineHeight}
                laneWidth={laneWidth}
                active={hoverJump === ji}
                onEnter={setHoverJump}
                onLeave={onLineLeave}
              />
            ))}
          </svg>
        )}

        {/* Instruction lines */}
        <div style={{ paddingLeft: section.maxLane >= 0 ? gutterWidth : 0 }}>
          {section.lines.map((line, i) => (
            <div
              key={i}
              className={`coba-line${highlightLines.has(i) ? ' coba-line-active' : ''}${line.isJump ? ' coba-line-jump' : ''}`}
              style={{ height: lineHeight, lineHeight: `${lineHeight}px` }}
              onMouseEnter={line.isJump ? () => onLineEnter(i) : undefined}
              onMouseLeave={line.isJump ? onLineLeave : undefined}
              dangerouslySetInnerHTML={{ __html: highlightInstr(line.raw) }}
            />
          ))}
        </div>
      </div>
      )}
    </div>
  )
}

function JumpArrow({
  jump,
  index,
  lineHeight,
  laneWidth,
  active,
  onEnter,
  onLeave,
}: {
  jump: Jump
  index: number
  lineHeight: number
  laneWidth: number
  active: boolean
  onEnter: (i: number) => void
  onLeave: () => void
}) {
  const fromY = jump.fromIdx * lineHeight + lineHeight / 2
  const toY = jump.toIdx * lineHeight + lineHeight / 2
  const x = (jump.lane + 1) * laneWidth
  const right = (jump.lane + 1) * laneWidth + 6
  const r = 4 // corner radius

  // Path: horizontal from right edge to lane column, vertical span, horizontal back
  // With rounded corners using arc commands
  const d = fromY < toY
    ? // Forward jump (down)
      `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY + r} V ${toY - r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
    : // Backward jump (up / loop)
      `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY - r} V ${toY + r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`

  const color = active
    ? '#ffcb6b'
    : jump.isLoop
      ? '#c792ea'
      : '#546e7a'

  return (
    <g
      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
      onMouseEnter={() => onEnter(index)}
      onMouseLeave={onLeave}
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={active ? 2 : 1.2}
        opacity={active ? 1 : 0.6}
      />
      {/* Arrowhead at target end */}
      <polygon
        points={arrowHead(right, toY)}
        fill={color}
        opacity={active ? 1 : 0.6}
      />
    </g>
  )
}

function arrowHead(x: number, y: number): string {
  // Right-pointing arrow
  return `${x},${y} ${x - 5},${y - 3} ${x - 5},${y + 3}`
}

// ── line-level syntax highlighting ─────────────────────────────────────────

const FLOW_SET = new Set(['JUMP', 'JUMP_IF_FALSE', 'RETURN', 'CALL_SCRIPT', 'START_SCRIPT'])
const STACK_SET = new Set(['PUSH_CONST', 'PUSH_LOCAL', 'PUSH_STATIC', 'POP_LOCAL', 'POP_STATIC', 'STACK_ALLOC', 'PUSH_CONSTANT', 'PUSH_LOCAL_VAR', 'POP_LOCAL_VAR'])
const ANIM_SET = new Set(['MOVE', 'MOVE_NOW', 'TURN', 'TURN_NOW', 'SPIN', 'STOP_SPIN', 'WAIT_FOR_TURN', 'WAIT_FOR_MOVE', 'SHOW', 'HIDE', 'CACHE', 'DONT_CACHE', 'DONT_SHADE', 'SHADE'])
const ARITH_SET = new Set(['ADD', 'SUB', 'MUL', 'DIV', 'BITWISE_AND', 'BITWISE_OR', 'BITWISE_XOR', 'BITWISE_NOT', 'LOGICAL_AND', 'LOGICAL_OR', 'LOGICAL_NOT', 'LESS_THAN', 'LESS_OR_EQUAL', 'GREATER_THAN', 'GREATER_OR_EQUAL', 'GREATER_EQUAL', 'EQUAL', 'NOT_EQUAL', 'RAND'])
// EFFECT_SET not used directly — op-effect is the default class for unmatched opcodes.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function sp(cls: string, content: string): string {
  return `<span class="coba-${cls}">${content}</span>`
}

function highlightDirective(line: string): string {
  const trimmed = line.trim()
  if (trimmed === '') return ''
  const m = trimmed.match(/^(\.(version|statics|piece|script))\s+(.*)$/)
  if (m) {
    if (m[1] === '.script') return sp('directive', esc(m[1])) + ' ' + sp('script-name', esc(m[3]))
    return sp('directive', esc(m[1])) + ' ' + sp('directive-arg', esc(m[3]))
  }
  if (trimmed.startsWith(';')) return sp('comment', esc(line))
  return esc(line)
}

function highlightInstr(line: string): string {
  const trimmed = line.trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith(';')) return sp('comment', esc(line))

  const m = trimmed.match(/^([0-9A-Fa-f]{4})\s+([A-Z_][A-Z_0-9]+)(.*)$/)
  if (!m) return esc(line)

  const [, offset, opcode, rest] = m
  let operandPart = rest
  let commentPart = ''
  const ci = rest.indexOf(';')
  if (ci >= 0) {
    operandPart = rest.slice(0, ci)
    commentPart = rest.slice(ci)
  }

  let opCls = 'op-effect'
  if (FLOW_SET.has(opcode)) opCls = 'op-flow'
  else if (STACK_SET.has(opcode)) opCls = 'op-stack'
  else if (ANIM_SET.has(opcode)) opCls = 'op-anim'
  else if (ARITH_SET.has(opcode)) opCls = 'op-arith'

  const ops = highlightOperands(operandPart)

  return sp('offset', esc(offset)) + '  ' + sp(opCls, esc(opcode)) + ops + (commentPart ? sp('comment', esc(commentPart)) : '')
}

function highlightOperands(text: string): string {
  if (!text.trim()) return esc(text)
  let result = '', lastIdx = 0
  const re = /-?\d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) result += esc(text.slice(lastIdx, m.index))
    result += sp('operand', esc(m[0]))
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) result += esc(text.slice(lastIdx))
  return result
}
