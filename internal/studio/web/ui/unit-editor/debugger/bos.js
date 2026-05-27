// bos.js
//
// BOS-pane renderer for the thread-code-view debugger.  Owns the
// decompiled-source side of the split — the function/statement
// folding, the bracket highlights, the BOS↔assembly cross-reference
// indexes used by the asm pane's hover / PC tracking.
//
// What lives here:
//
//   - renderMvThreadCodeDecompiled — paints the BOS pane (with a
//     pulsing skeleton placeholder while a decompile fetch is in
//     flight)
//   - renderMvBosSkeleton — the placeholder shown during fetch
//   - buildMvBosMap — one-time per-COB walk that builds the
//     two cross-reference maps (_bosMap line→asm range,
//     _asmToBos asm-idx→line) cached on cob.unit
//   - mvBosStatementMatch — heuristic that finds the asm
//     instruction range a single BOS statement compiled to (handles
//     turn/move/spin/wait/sleep/show/hide/return/start-script/etc.)
//   - applyMvThreadCodeCrossHover — mutual highlight between the
//     asm and BOS panes for the panel's hover state
//   - refreshMvThreadCodeDecompHighlight — per-tick "you are here"
//     marker on the BOS line whose mapped asm range covers the
//     current PC
//
// The asm-side renderer + bracket-curve overlay + per-tick PC tracker
// stay in studio.js; R43e moves them next.  Cross-pane calls (BOS
// breakpoint toggling syncs the asm pane's `.breakpointed` class,
// BOS-fold redraws brackets) reach asm.js via a same-section import.

import { hostCallbacks } from '../../host-context.js'
import { highlightBosLine } from './cob-highlight.js'
import { _mvThreadCodePanels } from './modal.js'
import { redrawMvThreadCodeBrackets } from './asm.js'

// mvBosStatementMatch tries to find the assembly instruction range
// corresponding to a single BOS source line.  Heuristic: each BOS
// statement has a recognisable tail opcode (TURN / MOVE / SPIN / SLEEP
// / RETURN / etc.); we walk forward from `cursor` looking for that
// opcode, then back over any preceding PUSH instructions that form
// its operand stack.  Returns { startIdx, endIdx } on a hit, null
// when the line is whitespace, a comment, a brace, or doesn't match
// any known statement shape.  Called by buildMvBosMap.
function mvBosStatementMatch(bosLine, instructions, cursor, pieceNames) {
  const text = bosLine.trim()
  if (!text || text.startsWith('//') || text === '{' || text === '}') return null
  // Strip trailing semicolon for matching.
  const stmt = text.replace(/;\s*(\/\/.*)?$/, '').trim()
  const pieceIdx = (name) => pieceNames.findIndex((p) => p && p.toLowerCase() === name.toLowerCase())
  const axisIdx = (a) => ({ 'x-axis': 0, 'y-axis': 1, 'z-axis': 2 }[a.toLowerCase()] ?? -1)
  // Try a few common shapes — find the relevant tail opcode at or
  // after `cursor`, then back up over its preceding pushes.
  // Helper: walk `cursor..` looking for the predicate's first match.
  const findIns = (pred) => {
    for (let i = cursor; i < instructions.length; i++) if (pred(instructions[i])) return i
    return -1
  }
  // Helper: count the immediately-preceding PUSH (any) instructions.
  const countPrecedingPushes = (idx) => {
    let n = 0
    for (let i = idx - 1; i >= cursor; i--) {
      const o = instructions[i].name
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

// buildMvBosVarNames extracts variable names from the (de)compiled
// BOS source so the debugger's Locals/Globals tray can label rows
// with their authored names instead of L0/global_0 placeholders.
// Two scopes:
//
//   - GLOBALS (module-scope `static-var` declarations).  These are
//     a flat positional list — first name declared is global index
//     0, second is index 1, etc.  Stored on cob.unit._globalNames
//     as a string[].
//
//   - LOCALS (per-function `var` declarations at the top of each
//     function body, or inline `var name = expr;` later).  Indexed
//     positionally within each function.  Stored as a Map<funcLower,
//     string[]> on cob.unit._localNamesByFn so the debugger can pick
//     the right list for whatever script the inspected thread is
//     currently running.
//
// The COB decompiler emits `global_N` / `local_N` placeholders when
// it can't recover original names; this parser captures those
// directly, so the labels read the same as the decompiled source.
// When the user later loads a hand-written .bos file (real names),
// the same parser picks up `var distance` or `static-var damage`
// and the debugger labels follow the source.  Idempotent — bails
// when both caches are already populated for this unit.
export function buildMvBosVarNames(cob) {
  if (cob.unit._globalNames && cob.unit._localNamesByFn) return
  const src = cob.unit.decompiled || cob.unit._decompiledSource
  cob.unit._globalNames = []
  cob.unit._localNamesByFn = new Map()
  if (!src) return
  // Module-scope `static-var X, Y, Z;`.  Allow multiple statements
  // (some sources split long lists) — concatenate every match.  Lines
  // starting with `//` or inside block comments aren't fully filtered;
  // false positives are harmless because the names are positional.
  const lines = src.split('\n')
  for (const ln of lines) {
    const m = ln.match(/^\s*static-var\s+([^;]+);/)
    if (!m) continue
    for (const n of m[1].split(',')) {
      const name = n.trim()
      if (name) cob.unit._globalNames.push(name)
    }
  }
  // Per-function `var X, Y, Z;`.  Walk the source tracking the
  // current function via brace depth — anything at depth 1+ inside
  // a `fn() { ... }` block counts as a local declaration for that
  // function.  Robust to nested control-flow blocks because we only
  // reset `currentFn` when depth returns to 0.
  let currentFn = null
  let depth = 0
  for (const ln of lines) {
    // Function header — name followed by `(` at column zero, depth 0.
    // The asm-pane mapping uses the same `NOT_A_FN` guard; we mirror
    // it here so `if (...)` / `while (...)` at depth 0 don't get
    // promoted to "we entered function `if`".
    if (depth === 0) {
      const fnMatch = ln.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*\(/)
      if (fnMatch && !NOT_A_FN.has(fnMatch[1].toLowerCase())) {
        currentFn = fnMatch[1].toLowerCase()
        if (!cob.unit._localNamesByFn.has(currentFn)) {
          cob.unit._localNamesByFn.set(currentFn, [])
        }
      }
    }
    // `var name1, name2, name3;` — strip any `= initializer` from
    // each comma-separated declaration before keeping the name.
    if (currentFn && depth >= 1) {
      const vm = ln.match(/^\s*var\s+([^;]+);/)
      if (vm) {
        const arr = cob.unit._localNamesByFn.get(currentFn)
        for (const decl of vm[1].split(',')) {
          const name = decl.split('=')[0].trim()
          if (name) arr.push(name)
        }
      }
    }
    // Track brace depth so we know when the current function ends.
    for (const c of ln) {
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) currentFn = null
      }
    }
  }
}

// NOT_A_FN — BOS keywords that look like function headers (have
// parens) but aren't.  Shared with buildMvBosMap below.
const NOT_A_FN = new Set(['if', 'else', 'while', 'for', 'return', 'get', 'rand'])

// buildMvBosMap walks the decompiled source once per COB to build the
// BOS↔assembly cross-reference structures used by every open debugger
// panel.  Stored on the runtime so multiple panels share the same
// map without re-walking.  Builds two indexes:
//   _bosMap : line idx → { script, startIdx, endIdx, startOffset }
//   _asmToBos : "scriptLower:asmIdx" → bos line idx  (reverse, for
//             mutual-hover highlighting)
export function buildMvBosMap(cob) {
  if (cob.unit._bosMap && cob.unit._asmToBos) return
  const src = cob.unit.decompiled || cob.unit._decompiledSource
  cob.unit._bosMap = new Map()
  cob.unit._asmToBos = new Map()
  if (!src) return
  const lines = src.split('\n')
  // NOT_A_FN is hoisted to module scope so buildMvBosVarNames +
  // renderMvThreadCodeDecompiled share the same exclusion set.
  let currentFn = null
  let cursor = 0
  let scriptInsts = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const m = ln.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*\(/)
    if (m && !NOT_A_FN.has(m[1].toLowerCase())) {
      currentFn = m[1]
      const scriptIdx = cob.unit.scriptNames.findIndex((n) => n && n.toLowerCase() === m[1].toLowerCase())
      scriptInsts = scriptIdx >= 0 ? (cob.unit.scripts[scriptIdx]?.instructions || null) : null
      cursor = 0
    } else if (scriptInsts && currentFn) {
      const match = mvBosStatementMatch(ln, scriptInsts, cursor, cob.unit.pieceNames)
      if (match) {
        cob.unit._bosMap.set(i, {
          script: currentFn,
          startIdx: match.startIdx,
          endIdx: match.endIdx,
          startOffset: scriptInsts[match.startIdx].offset,
        })
        const fnLower = currentFn.toLowerCase()
        for (let a = match.startIdx; a <= match.endIdx; a++) {
          cob.unit._asmToBos.set(`${fnLower}:${a}`, i)
        }
        cursor = match.endIdx + 1
      }
    }
  }
}

export function renderMvThreadCodeDecompiled(state, cob) {
  const pane = state.panel.querySelector('.mv-thread-code-decompiled')
  if (!pane) return
  pane.replaceChildren()
  const src = cob.unit.decompiled || cob.unit._decompiledSource
  if (!src) {
    // Decompile isn't loaded yet (model-load fetch used
    // ?decompile=0 to skip the slow pass).  Kick off a one-shot
    // fetch, show a skeleton while it runs, and re-enter on success.
    // _decompileFetchInFlight guards against double-fetch when
    // multiple debugger panels open while one fetch is still in
    // flight.
    const activeMv = hostCallbacks.getActiveModelViewer?.()
    const name = cob.unit.scriptOriginName || cob.unit.name || (activeMv?.model?.name)
    if (!name) {
      pane.textContent = '// decompile unavailable'
      return
    }
    renderMvBosSkeleton(pane)
    if (!cob.unit._decompileFetchInFlight) {
      cob.unit._decompileFetchInFlight = fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=1`)
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((json) => {
          cob.unit._decompiledSource = json.decompiled || '// decompile failed'
          // Bust cached maps so they rebuild against the fetched
          // source — var-name lookups for the debugger's Locals /
          // Globals tray live in the same family of indices and
          // must follow the same invalidation lifecycle.
          cob.unit._bosMap = null
          cob.unit._asmToBos = null
          cob.unit._globalNames = null
          cob.unit._localNamesByFn = null
        })
        .catch((err) => { cob.unit._decompiledSource = `// decompile fetch failed: ${err.message}` })
        .finally(() => { cob.unit._decompileFetchInFlight = null })
    }
    // Re-enter once the fetch settles.  Use the shared promise so
    // every open panel waits on the same fetch.
    cob.unit._decompileFetchInFlight.then(() => {
      // Re-render every open panel that's pointing at this same cob —
      // when the fetch lands, every debugger's BOS pane needs to
      // refresh from the now-cached source.
      for (const s of _mvThreadCodePanels.values()) {
        if (s.cob === cob) renderMvThreadCodeDecompiled(s, cob)
      }
    })
    return
  }
  buildMvBosMap(cob)
  buildMvBosVarNames(cob)
  const lines = src.split('\n')
  // NOT_A_FN (module-scope) tags `if (cond)` / `while (...)` / etc. so
  // we don't treat them as function-header rows when assigning the
  // dataset.fn / dataset.fnParent attributes the fold handler uses.
  // Track the function the current body lines belong to so each line
  // can be tagged with `data-fn-parent="<fn>"` — the fold handler
  // uses this attribute to hide an entire function in one query.
  let currentFnLower = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const div = document.createElement('div')
    div.dataset.line = String(i)
    // Line-number gutter — 1-based, matches what most editors show.
    // Lives outside the syntax-highlighted span so it doesn't get
    // selected when the user copies a chunk of source.
    const lineNo = document.createElement('span')
    lineNo.className = 'bos-lineno'
    lineNo.textContent = String(i + 1)
    div.appendChild(lineNo)
    const m = ln.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*\(/)
    if (m && !NOT_A_FN.has(m[1].toLowerCase())) {
      div.dataset.fn = m[1].toLowerCase()
      div.classList.add('bos-fn-header')
      currentFnLower = m[1].toLowerCase()
      // Fold caret prepended to the function-header text.  Click
      // toggles `.bos-fn-collapsed` on the header + hides every line
      // whose data-fn-parent matches this function.
      const caret = document.createElement('span')
      caret.className = 'bos-fold-caret'
      caret.textContent = '▾'
      div.appendChild(caret)
      div.appendChild(document.createTextNode(' '))
    } else if (currentFnLower) {
      div.dataset.fnParent = currentFnLower
    }
    div.insertAdjacentHTML('beforeend', highlightBosLine(ln || ' '))
    // Reflect breakpoint state on initial render.
    const mapEntry = cob.unit._bosMap.get(i)
    if (mapEntry && cob.unit.hasBreakpoint(mapEntry.script, mapEntry.startOffset)) {
      div.classList.add('bos-bp')
    }
    // Stamp the mapped (script, startOffset) on the BOS row so the
    // refresh-tick coverage sweep can look the offset up in
    // _executedOffsets without re-walking _bosMap.  Also dim the row
    // initially if the asm range hasn't been executed yet — the
    // refresh tick will undim it once the runtime stamps the
    // offset.  Unmapped lines (blanks, comments, braces) stay at
    // normal opacity since they have no asm to gate them.
    if (mapEntry) {
      const scriptLower = mapEntry.script.toLowerCase()
      div.dataset.bosScript = scriptLower
      div.dataset.bosOffset = String(mapEntry.startOffset >>> 0)
      const cov = cob.unit._executedOffsets?.get(scriptLower)
      if (!cov || !cov.has(mapEntry.startOffset >>> 0)) {
        div.classList.add('bos-unexecuted')
      }
    }
    // Click behaviour depends on line kind:
    //  · function header → fold/expand the function body
    //  · mapped statement → toggle a breakpoint at its first asm instr
    //  · unmapped line → no-op
    if (div.classList.contains('bos-fn-header')) {
      div.addEventListener('click', () => {
        const fn = div.dataset.fn
        const collapsed = div.classList.toggle('bos-fn-collapsed')
        const caret = div.querySelector('.bos-fold-caret')
        if (caret) caret.textContent = collapsed ? '▸' : '▾'
        const sel = `.mv-thread-code-decompiled > div[data-fn-parent="${fn}"]`
        for (const row of pane.querySelectorAll(sel)) {
          row.classList.toggle('bos-fn-hidden', collapsed)
        }
        // Bracket curves depend on which BOS lines are visible.
        requestAnimationFrame(() => redrawMvThreadCodeBrackets(state))
      })
    } else {
      div.addEventListener('click', () => {
        const entry = cob.unit._bosMap.get(i)
        if (!entry) return
        const scriptLower = entry.script.toLowerCase()
        const asmLine = state.panel.querySelector(`.mv-thread-code-source .mv-code-line[data-script="${scriptLower}"][data-offset="${entry.startOffset}"]`)
        if (cob.unit.hasBreakpoint(entry.script, entry.startOffset)) {
          cob.unit.removeBreakpoint(entry.script, entry.startOffset)
          div.classList.remove('bos-bp')
          if (asmLine) asmLine.classList.remove('breakpointed')
        } else {
          cob.unit.addBreakpoint(entry.script, entry.startOffset)
          div.classList.add('bos-bp')
          if (asmLine) asmLine.classList.add('breakpointed')
        }
      })
    }
    pane.appendChild(div)
  }
  // After the BOS DOM mounts, paint the cross-pane curves — the
  // panel may have been visible (and asm rendered) for a while
  // waiting on the decompile fetch, so don't rely on the next refresh
  // tick to bring them in.
  requestAnimationFrame(() => redrawMvThreadCodeBrackets(state))
}

// renderMvBosSkeleton paints a placeholder "loading…" pattern in
// the BOS pane while the decompile fetch is in flight.  Each row is
// a pulsing rectangle of varying width so the pane reads as "code
// is incoming" rather than "panel is broken".  Cheap — replaced
// once the fetch resolves and the real source renders.
function renderMvBosSkeleton(pane) {
  pane.replaceChildren()
  const wrap = document.createElement('div')
  wrap.className = 'mv-bos-skeleton'
  // Repeated pattern of bar widths so it looks like indented code
  // (function headers + bodies).  Repeats give the user enough
  // visual context to recognise it's a code skeleton.
  const widths = [
    '38%','82%','64%','55%','70%','38%','58%','46%','42%','62%',
    '34%','78%','60%','52%','68%','42%','64%','48%','40%','58%',
  ]
  for (let i = 0; i < widths.length; i++) {
    const bar = document.createElement('div')
    bar.className = 'mv-bos-skeleton-bar'
    bar.style.width = widths[i]
    bar.style.marginLeft = (i % 4 === 0) ? '0' : ((i % 4) * 8 + 'px')
    bar.style.animationDelay = (i * 60) + 'ms'
    wrap.appendChild(bar)
  }
  pane.appendChild(wrap)
}

// applyMvThreadCodeCrossHover sets `.cross-hover` on the asm lines
// and `.bos-cross-hover` on the BOS line for the panel's current
// hover target.  Called from both the asm and BOS pane hover
// handlers so the link is mutual.  Cheap — touches a handful of
// elements.
export function applyMvThreadCodeCrossHover(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  for (const el of src.querySelectorAll('.mv-code-line.cross-hover')) el.classList.remove('cross-hover')
  for (const el of dec.querySelectorAll('div.bos-cross-hover')) el.classList.remove('bos-cross-hover')
  if (state.hoverLine === null || state.hoverLine === undefined) return
  const entry = state.cob.unit._bosMap?.get(state.hoverLine)
  if (!entry) return
  const scriptLower = entry.script.toLowerCase()
  for (let i = entry.startIdx; i <= entry.endIdx; i++) {
    const asmLine = src.querySelector(`.mv-code-line[data-script="${scriptLower}"][data-idx="${i}"]`)
    if (asmLine) asmLine.classList.add('cross-hover')
  }
  const bosEl = dec.querySelector(`div[data-line="${state.hoverLine}"]`)
  if (bosEl) bosEl.classList.add('bos-cross-hover')
}

// refreshMvThreadCodeDecompHighlight lights up the BOS line whose
// mapped asm range covers the current PC.  Per-statement (not
// whole-function) so the "you are here" cue is precise.  Called
// from the per-tick studio.js refreshMvThreadCodeHighlight after
// the asm-side PC marker has been updated.
export function refreshMvThreadCodeDecompHighlight(state, thread) {
  const pane = state.panel.querySelector('.mv-thread-code-decompiled')
  if (!pane) return
  // Light up ONLY the BOS line whose mapped asm range covers the
  // current PC.  Whole-function highlighting (the prior behaviour)
  // washed out the "you are here" cue; per-statement is precise
  // since `_bosMap` already gives us the asm-range per BOS line.
  for (const el of pane.querySelectorAll('.bos-current')) el.classList.remove('bos-current')
  if (!thread) return
  const fnLower = thread.script.name.toLowerCase()
  const map = state.cob.unit._bosMap
  if (!map) return
  let bestLine = -1
  for (const [lineIdx, entry] of map.entries()) {
    if (entry.script.toLowerCase() !== fnLower) continue
    if (thread.pc >= entry.startIdx && thread.pc <= entry.endIdx) {
      bestLine = lineIdx
      break
    }
  }
  if (bestLine < 0) return
  const lineEl = pane.querySelector(`div[data-line="${bestLine}"]`)
  if (lineEl) {
    lineEl.classList.add('bos-current')
    // Centring is handled by centerMvThreadPanesOnPc (called from
    // refreshMvThreadCodeHighlight) so we don't double-scroll.
  }
}
