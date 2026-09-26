// bos-match.js
//
// Maps a line of decompiled BOS to the assembly instructions it compiled
// to, for the thread debugger's BOS <-> assembly cross-reference (see
// bos.js buildMvBosMap).  Pure: no DOM, so node --test covers it.

import { baseOpName } from './cob-highlight.js'

// bosStatementMatch tries to find the assembly instruction range
// corresponding to a single BOS source line.  Heuristic: each BOS
// statement has a recognisable tail opcode (TURN / MOVE / SPIN / SLEEP
// / RETURN / etc.); we walk forward from `cursor` looking for that
// opcode, then back over any preceding PUSH instructions that form
// its operand stack.  Returns { startIdx, endIdx } on a hit, null
// when the line is whitespace, a comment, a brace, or doesn't match
// any known statement shape.  Called by buildMvBosMap.
export function bosStatementMatch(bosLine, instructions, cursor, pieceNames) {
  const text = bosLine.trim()
  if (!text || text.startsWith('//') || text === '{' || text === '}') return null
  // Strip trailing semicolon for matching.
  const stmt = text.replace(/;\s*(\/\/.*)?$/, '').trim()
  const pieceIdx = (name) => pieceNames.findIndex((p) => p && p.toLowerCase() === name.toLowerCase())
  const axisIdx = (a) => ({ 'x-axis': 0, 'y-axis': 1, 'z-axis': 2 }[a.toLowerCase()] ?? -1)
  // Try a few common shapes — find the relevant tail opcode at or
  // after `cursor`, then back up over its preceding pushes.
  // Helper: walk `cursor..` looking for the predicate's first match.
  // Predicates see the base name: NAME@0x… runs as NAME.
  const findIns = (pred) => {
    for (let i = cursor; i < instructions.length; i++) {
      const ins = instructions[i]
      if (pred({ name: baseOpName(ins.name), p1: ins.p1, p2: ins.p2 })) return i
    }
    return -1
  }
  // Helper: count the immediately-preceding PUSH (any) instructions.
  const countPrecedingPushes = (idx) => {
    let n = 0
    for (let i = idx - 1; i >= cursor; i--) {
      const o = baseOpName(instructions[i].name)
      if (o === 'PUSH_CONST' || o === 'PUSH_LOCAL' || o === 'PUSH_STATIC') n++
      else break
    }
    return n
  }
  let m
  // turn/move X to Y-axis ...
  m = stmt.match(/^(turn|move)\s+(\S+)\s+to\s+(x-axis|y-axis|z-axis)\s+/i)
  if (m) {
    const [, kind, piece, axis] = m
    const isNow = /\bnow\b/.test(stmt)
    const op = kind.toLowerCase() === 'turn' ? (isNow ? 'TURN_NOW' : 'TURN') : (isNow ? 'MOVE_NOW' : 'MOVE')
    const pi = pieceIdx(piece), ai = axisIdx(axis)
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi && ins.p2 === ai)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // spin / stop-spin
  m = stmt.match(/^(spin|stop-spin)\s+(\S+)\s+around\s+(x-axis|y-axis|z-axis)/i)
  if (m) {
    const op = m[1].toLowerCase() === 'spin' ? 'SPIN' : 'STOP_SPIN'
    const pi = pieceIdx(m[2]), ai = axisIdx(m[3])
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi && ins.p2 === ai)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // wait-for-turn / wait-for-move
  m = stmt.match(/^wait-for-(turn|move)\s+(\S+)\s+(?:around|along)\s+(x-axis|y-axis|z-axis)/i)
  if (m) {
    const op = m[1].toLowerCase() === 'turn' ? 'WAIT_FOR_TURN' : 'WAIT_FOR_MOVE'
    const pi = pieceIdx(m[2]), ai = axisIdx(m[3])
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi && ins.p2 === ai)
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  // sleep <V>
  if (/^sleep\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'SLEEP')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // show / hide / cache / dont-cache / dont-shade
  m = stmt.match(/^(show|hide|cache|dont-cache|dont-shade)\s+(\S+)/i)
  if (m) {
    const op = m[1].toUpperCase().replace('-', '_')
    const pi = pieceIdx(m[2])
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi)
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  // return [val]
  if (/^return\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'RETURN')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // start-script / call-script
  m = stmt.match(/^(start-script|call-script)\s+(\w+)/i)
  if (m) {
    const op = m[1].toLowerCase() === 'start-script' ? 'START_SCRIPT' : 'CALL_SCRIPT'
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // signal / set-signal-mask
  m = stmt.match(/^(signal|set-signal-mask)\b/i)
  if (m) {
    const op = m[1].toLowerCase() === 'signal' ? 'SIGNAL' : 'SET_SIGNAL_MASK'
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // emit-sfx / explode
  m = stmt.match(/^(emit-sfx|explode)\b/i)
  if (m) {
    const op = m[1].toLowerCase() === 'emit-sfx' ? 'EMIT_SFX' : 'EXPLODE'
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // if (cond) — compiles to [cond pushes] + JUMP_IF_FALSE.  Both `if`
  // and `else if` land here; the `else` keyword on its own is just a
  // JUMP, handled separately below.
  if (/^(if|else\s+if|while)\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'JUMP_IF_FALSE')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // bare `else` — compiles to a JUMP over the else body.  Skip if not
  // followed by an `if`.
  if (/^else\b/i.test(stmt) && !/^else\s+if\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'JUMP')
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  // set static-var-X = expr; or set X = expr;  — compiles to
  // [expr pushes] + POP_LOCAL/POP_STATIC.
  if (/^set\b/i.test(stmt) || /^[A-Za-z_][\w-]*\s*=/.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'POP_LOCAL' || ins.name === 'POP_STATIC')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // var X = expr;  — local declaration with initializer.  Same shape
  // as a set: pushes then POP_LOCAL (sometimes preceded by
  // CREATE_LOCAL).
  if (/^var\s+/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'POP_LOCAL' || ins.name === 'CREATE_LOCAL')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // get UNIT-VALUE …; standalone (expression-as-statement — uncommon
  // but appears in some scripts).  Match the GET op directly.
  if (/^get\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'GET' || ins.name === 'GET_UNIT_VALUE')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // attach-unit / drop-unit
  m = stmt.match(/^(attach-unit|drop-unit)\b/i)
  if (m) {
    const op = m[1].toLowerCase().replace('-', '_').toUpperCase()
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // dont-shadow (separate from dont-shade) — matches DONT_SHADOW.
  m = stmt.match(/^dont-shadow\s+(\S+)/i)
  if (m) {
    const pi = pieceIdx(m[1])
    const idx = findIns((ins) => ins.name === 'DONT_SHADOW' && ins.p1 === pi)
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  return null
}
