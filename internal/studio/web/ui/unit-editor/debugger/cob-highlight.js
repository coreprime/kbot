// Shared COB tokenizers + control-flow helpers.  Algorithm mirrors
// the explorer's BOSHighlighter / COBAHighlighter components so studio
// and explorer render the same code identically.  Pure functions only
// — DOM-building lives in callers.  The explorer should eventually
// import this module too (currently keeps its own TSX copy; refactor
// is a follow-up).
//
// Class naming convention matches the explorer's index.css:
//   .bos-keyword .bos-builtin .bos-modifier .bos-axis .bos-fn-name
//   .bos-ident   .bos-number  .bos-angle-num .bos-comment
//   .bos-preprocessor .bos-punct
//   .coba-offset .coba-op-flow .coba-op-stack .coba-op-anim
//   .coba-op-arith .coba-op-effect .coba-operand .coba-comment
//   .coba-directive .coba-directive-arg .coba-script-name

// ── BOS source tokenisation ───────────────────────────────────────

const BOS_KEYWORDS = new Set([
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
const BOS_BUILTIN_FNS = new Set(['get', 'rand'])
const BOS_MODIFIERS = new Set(['now', 'speed', 'accelerate', 'decelerate', 'to', 'around'])
const BOS_AXES = new Set(['x-axis', 'y-axis', 'z-axis'])

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function bosSpan(cls, content) {
  return `<span class="bos-${cls}">${content}</span>`
}

// highlightBosLine returns an HTML string with token spans for one
// BOS source line.  Mirrors the explorer's highlightLine without the
// #include link-rewriting (studio has no file-system view).
export function highlightBosLine(line) {
  const leadMatch = line.match(/^(\s*)(.*)$/)
  if (!leadMatch) return escHtml(line)
  const indent = leadMatch[1]
  let rest = leadMatch[2]

  if (rest.startsWith('#')) return indent + bosSpan('preprocessor', escHtml(rest))
  if (rest.startsWith('//')) return indent + bosSpan('comment', escHtml(rest))

  let comment = ''
  const commentIdx = rest.indexOf('//')
  if (commentIdx >= 0) {
    comment = rest.slice(commentIdx)
    rest = rest.slice(0, commentIdx)
  }

  return indent + highlightBosTokens(rest) + (comment ? bosSpan('comment', escHtml(comment)) : '')
}

function highlightBosTokens(text) {
  const pattern = /(<\d+>)|(\d+)|([a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z_][a-zA-Z0-9_]*)*)|([{}();,=!<>+\-*/%|&]+)|(\s+)/g
  let result = ''
  let lastIndex = 0
  let m
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) result += escHtml(text.slice(lastIndex, m.index))
    lastIndex = m.index + m[0].length
    const token = m[0]
    if (m[1]) { result += bosSpan('angle-num', escHtml(token)); continue }
    if (m[2]) { result += bosSpan('number', escHtml(token)); continue }
    if (m[3]) {
      const lower = token.toLowerCase()
      if (BOS_KEYWORDS.has(lower)) { result += bosSpan('keyword', escHtml(token)); continue }
      if (BOS_BUILTIN_FNS.has(lower)) { result += bosSpan('builtin', escHtml(token)); continue }
      if (BOS_MODIFIERS.has(lower)) { result += bosSpan('modifier', escHtml(token)); continue }
      if (BOS_AXES.has(lower)) { result += bosSpan('axis', escHtml(token)); continue }
      // peek ahead — identifier followed by `(` is a function call/name.
      result += bosSpan(text[lastIndex] === '(' ? 'fn-name' : 'ident', escHtml(token))
      continue
    }
    if (m[4]) { result += bosSpan('punct', escHtml(token)); continue }
    if (m[5]) { result += token; continue }
    result += escHtml(token)
  }
  if (lastIndex < text.length) result += escHtml(text.slice(lastIndex))
  return result
}

// ── COBA instruction tokenisation ─────────────────────────────────

const COBA_FLOW = new Set(['JUMP', 'JUMP_IF_FALSE', 'RETURN', 'CALL_SCRIPT', 'START_SCRIPT', 'DISCARD_CALL'])
const COBA_STACK = new Set(['PUSH_CONST', 'PUSH_LOCAL', 'PUSH_STATIC', 'POP_LOCAL', 'POP_STATIC', 'STACK_ALLOC', 'PUSH_CONSTANT', 'PUSH_LOCAL_VAR', 'POP_LOCAL_VAR'])
const COBA_ANIM = new Set(['MOVE', 'MOVE_NOW', 'TURN', 'TURN_NOW', 'SPIN', 'STOP_SPIN', 'WAIT_FOR_TURN', 'WAIT_FOR_MOVE', 'SHOW', 'HIDE', 'CACHE', 'DONT_CACHE', 'DONT_SHADE', 'SHADE', 'SLEEP'])
// Mnemonics as kbot-io's disassembler writes them: 0x10037000 is XOR,
// 0x10038000 the unary NOT and 0x10059000 a second XOR (XOR_ALT). The
// assembler still reads the names older listings used for those words
// (MOD, BITWISE_XOR, BITWISE_NOT, LOGICAL_XOR), so they are coloured too.
export const COBA_ARITH_OPS = [
  'ADD', 'SUB', 'MUL', 'DIV', 'BITWISE_AND', 'BITWISE_OR', 'XOR', 'NOT', 'XOR_ALT',
  'TAK_MATH_09', 'TAK_MATH_0A', 'TAK_MATH_0B',
  'LOGICAL_AND', 'LOGICAL_OR', 'LOGICAL_NOT', 'LESS_THAN', 'LESS_OR_EQUAL', 'GREATER_THAN',
  'GREATER_EQUAL', 'EQUAL', 'NOT_EQUAL', 'RAND',
  'MOD', 'BITWISE_XOR', 'BITWISE_NOT', 'LOGICAL_XOR', 'GREATER_OR_EQUAL',
]
const COBA_ARITH = new Set(COBA_ARITH_OPS)

// baseOpName returns the instruction a mnemonic names.  A word with stray
// low bits is written NAME@0x… and runs as NAME, so anything that matches
// instructions by name compares base names.
export function baseOpName(name) {
  return String(name || '').split('@')[0]
}

// cobaOpCategory returns the explorer's class name for the opcode.
export function cobaOpCategory(opcode) {
  opcode = baseOpName(opcode)
  if (COBA_FLOW.has(opcode)) return 'coba-op-flow'
  if (COBA_STACK.has(opcode)) return 'coba-op-stack'
  if (COBA_ANIM.has(opcode)) return 'coba-op-anim'
  if (COBA_ARITH.has(opcode)) return 'coba-op-arith'
  return 'coba-op-effect'
}

// highlightCobaOperands wraps numeric runs in .coba-operand.
export function highlightCobaOperands(text) {
  if (!text || !text.trim()) return escHtml(text || '')
  let result = '', lastIdx = 0
  const re = /-?\d+/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) result += escHtml(text.slice(lastIdx, m.index))
    result += `<span class="coba-operand">${escHtml(m[0])}</span>`
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) result += escHtml(text.slice(lastIdx))
  return result
}

// ── jump-arrow lane computation ───────────────────────────────────

// computeJumps assigns lane (column) indexes to JUMP / JUMP_IF_FALSE
// instructions so the arrow-overlay can draw vertical connectors
// without overlapping.  Greedy interval-scheduling by span width:
// shorter jumps get inner lanes (lane 0 closest to text).  Returns
// `{ jumps: [{ fromIdx, toIdx, lane, isLoop }], maxLane }`.
//
// instructions[]: each element must have .offset (number) and .name
// (string; NAME@0x… counts as NAME).  For JUMP-family instructions, .p1
// holds the target byte offset.  isLoop is heuristic — true when the target offset is at or
// before the source.
export function computeJumps(instructions) {
  const offsetMap = new Map()
  for (let i = 0; i < instructions.length; i++) {
    offsetMap.set(instructions[i].offset >>> 0, i)
  }
  const raw = []
  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i]
    const name = baseOpName(ins.name)
    if (name !== 'JUMP' && name !== 'JUMP_IF_FALSE') continue
    const targetOffset = ins.p1 >>> 0
    const toIdx = offsetMap.get(targetOffset)
    if (toIdx === undefined) continue
    raw.push({ fromIdx: i, toIdx, isLoop: toIdx <= i })
  }
  // Greedy lane assignment — shorter spans first.
  const sorted = [...raw].sort((a, b) => Math.abs(a.toIdx - a.fromIdx) - Math.abs(b.toIdx - b.fromIdx))
  const laneEnds = []
  const jumps = []
  for (const j of sorted) {
    const top = Math.min(j.fromIdx, j.toIdx)
    const bot = Math.max(j.fromIdx, j.toIdx)
    let lane = 0
    while (lane < laneEnds.length) {
      if (laneEnds[lane] < top) break
      lane++
    }
    if (lane >= laneEnds.length) laneEnds.push(-1)
    laneEnds[lane] = bot
    jumps.push({ ...j, lane })
  }
  return { jumps, maxLane: laneEnds.length - 1 }
}

// formatCobOperands renders an instruction's inline operands for the
// debugger's assembly pane: piece and axis names, script indexes, local and
// static slots and jump targets.  NAME@0x… is formatted as NAME.
export function formatCobOperands(ins, pieceNames) {
  const name = baseOpName(ins.name)
  // Piece-targeted ops with axis: piece name + axis letter
  const pieceAxisOps = new Set(['MOVE', 'TURN', 'SPIN', 'STOP_SPIN', 'MOVE_NOW', 'TURN_NOW', 'WAIT_FOR_TURN', 'WAIT_FOR_MOVE'])
  if (pieceAxisOps.has(name)) {
    const pn = pieceNames[ins.p1] || `#${ins.p1}`
    const axis = ['x', 'y', 'z'][ins.p2 | 0] || '?'
    return `${pn}, ${axis}-axis`
  }
  // Piece-only ops
  const pieceOps = new Set(['SHOW', 'HIDE', 'CACHE', 'DONT_CACHE', 'SHADE', 'DONT_SHADE', 'DONT_SHADOW', 'EMIT_SFX', 'EXPLODE'])
  if (pieceOps.has(name)) {
    const pn = pieceNames[ins.p1] || `#${ins.p1}`
    return pn
  }
  // CALL / START — index into scripts array
  if (name === 'CALL_SCRIPT' || name === 'START_SCRIPT') {
    return `script[${ins.p1}], ${ins.p2 | 0} args`
  }
  // PUSH_CONST + immediate ops
  if (name === 'PUSH_CONST') return `${ins.p1}`
  if (name === 'PUSH_LOCAL' || name === 'POP_LOCAL' || name === 'CREATE_LOCAL') return `L${ins.p1}`
  if (name === 'PUSH_STATIC' || name === 'POP_STATIC') return `global_${ins.p1}`
  if (name === 'JUMP' || name === 'JUMP_IF_FALSE') return `→ 0x${(ins.p1 >>> 0).toString(16)}`
  if (ins.p1 || ins.p2) return `${ins.p1}${ins.p2 ? `, ${ins.p2}` : ''}`
  return ''
}
