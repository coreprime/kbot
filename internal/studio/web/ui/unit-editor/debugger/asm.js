// asm.js
//
// Assembly-pane renderer for the thread-code-view debugger.  Owns
// the disassembly side of the split — every script's instruction
// stream rendered as numbered lines with PC marker + breakpoint dot
// + opcode + operands, plus the lockstep scroll sync + the SVG
// curve overlay that connects each asm line to its BOS counterpart.
//
// What lives here:
//
//   - renderMvThreadCodeSource — paints every script's disassembly
//     into the panel's asm pane, with per-script jump-arrow gutters
//   - mvBuildAsmLine — single instruction row (line number, PC
//     marker, BP dot, offset, opcode, operands) with cross-hover +
//     BP-toggle handlers
//   - drawMvJumpArrows — per-section SVG that paints jump curves
//     in the gutter
//   - mvFormatOperands / mvOpCategory — instruction-text helpers
//   - mvSyncBosBpForOffset — keeps the BOS pane's `.bos-bp` class
//     in sync when a BP is toggled from the asm side
//   - refreshMvThreadCodeHighlight — per-tick PC tracking +
//     execution status, called from the inspector refresh loop
//   - centerMvThreadPanesOnPc — auto-scroll both panes so the
//     current PC stays vertically centred as the thread runs
//   - wireMvThreadCodeBrackets — bracket-overlay listeners
//     (scroll lockstep + hover snap + panel resize)
//   - syncScrollFromAsm / syncScrollFromBos — the lockstep handlers
//   - redrawMvThreadCodeBrackets — SVG bezier curves from each
//     visible asm line to its mapped BOS line
//   - wireMvPcDrag + mvSetThreadPc — click / drag-drop PC editing
//
// Cross-module deps come through host-context (cob-highlight for
// the opcode category + jump-computation helpers, hostCallbacks for
// renderMvThreadCodeLocals which still lives studio-side) + the
// sibling bos.js (applyMvThreadCodeCrossHover, refreshMvThreadCodeDecompHighlight).

import { hostCallbacks } from '../../host-context.js'
import { cobaOpCategory, computeJumps as sharedComputeJumps } from '../../../cob-highlight.js'
import {
  applyMvThreadCodeCrossHover,
  refreshMvThreadCodeDecompHighlight,
} from './bos.js'

// mvOpCategory delegates to the shared cob-highlight module so studio
// and explorer produce identical opcode classes.
function mvOpCategory(name) { return cobaOpCategory(name) }

// renderMvThreadCodeSource paints the WHOLE disassembly (all scripts
// in the COB, not just the currently-executing one).  Each script
// gets its own section header + jump-arrow gutter.  Lines carry
// data-script + data-idx so the cross-pane curves, PC tracking, and
// BP lookups can find them by script name regardless of which thread
// currently owns the panel.
export function renderMvThreadCodeSource(state, thread) {
  const panel = state.panel
  const cob = state.cob
  const src = panel.querySelector('.mv-thread-code-source')
  const title = panel.querySelector('.mv-thread-code-title')
  if (!src) return
  src.replaceChildren()
  // dataset.scriptName tracks the thread's CURRENT script — used by
  // refreshMvThreadCodeHighlight to detect script changes (via
  // CALL_SCRIPT) and trigger PC-centring.  Still useful even though
  // we render all scripts.
  if (thread) {
    src.dataset.scriptName = thread.script.name
    if (title) title.textContent = `Thread #${thread.id} · ${thread.script.name}`
  }
  const pieceNames = cob.unit.pieceNames || []
  const scripts = cob.unit.scripts || []
  const LANE_W = 10
  // outerBody hosts every script section back-to-back.  Each section
  // is its own positioning context so per-script jump arrows don't
  // overlap into adjacent script gutters.
  const outerBody = document.createElement('div')
  outerBody.className = 'mv-code-outer'
  // Track jump computations per section so the post-mount RAF can
  // paint each section's arrows independently.
  const sectionRenders = []
  for (let si = 0; si < scripts.length; si++) {
    const script = scripts[si]
    if (!script) continue
    const scriptName = script.name
    const scriptLower = scriptName.toLowerCase()
    const instructions = script.instructions || []
    const section = document.createElement('div')
    section.className = 'mv-code-script'
    section.dataset.script = scriptLower
    // Header — clickable to collapse/expand the section body.
    const header = document.createElement('div')
    header.className = 'mv-code-script-header'
    const caret = document.createElement('span')
    caret.className = 'mv-code-fold-caret'
    caret.textContent = '▾'
    const hdrText = document.createElement('span')
    hdrText.className = 'coba-directive'
    hdrText.textContent = '.script '
    const hdrName = document.createElement('span')
    hdrName.className = 'coba-script-name'
    hdrName.textContent = scriptName
    header.appendChild(caret)
    header.appendChild(hdrText)
    header.appendChild(hdrName)
    section.appendChild(header)
    // Per-section body — positioning context for jump arrows.
    const sBody = document.createElement('div')
    sBody.className = 'mv-code-body'
    const { jumps, maxLane } = sharedComputeJumps(instructions)
    const gutterW = maxLane >= 0 ? (maxLane + 1) * LANE_W + 6 : 0
    sBody.style.paddingLeft = (gutterW ? (gutterW + 4) : 0) + 'px'
    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    arrowSvg.classList.add('mv-code-arrows')
    arrowSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    arrowSvg.setAttribute('overflow', 'visible')
    arrowSvg.style.position = 'absolute'
    arrowSvg.style.left = '0'
    arrowSvg.style.top = '0'
    arrowSvg.style.width = (gutterW || 0) + 'px'
    arrowSvg.style.pointerEvents = 'none'
    sBody.appendChild(arrowSvg)
    for (let i = 0; i < instructions.length; i++) {
      const ins = instructions[i]
      const line = mvBuildAsmLine(state, scriptLower, scriptName, i, ins, pieceNames)
      sBody.appendChild(line)
    }
    // Collapse / expand handler — toggle a class on the section.
    header.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed')
      caret.textContent = collapsed ? '▸' : '▾'
      requestAnimationFrame(() => redrawMvThreadCodeBrackets(state))
    })
    section.appendChild(sBody)
    outerBody.appendChild(section)
    sectionRenders.push({ sBody, arrowSvg, jumps, gutterW })
  }
  src.appendChild(outerBody)
  // After lines mount, paint each section's jump arrows.
  requestAnimationFrame(() => {
    for (const s of sectionRenders) {
      drawMvJumpArrows(s.sBody, s.arrowSvg, s.jumps, LANE_W, s.gutterW)
    }
  })
}

// mvBuildAsmLine constructs one assembly row — PC marker + BP dot +
// offset + opcode + operands — wired with click/hover handlers.
// Extracted so renderMvThreadCodeSource stays readable while still
// driving the same line shape across every script section.
function mvBuildAsmLine(state, scriptLower, scriptName, i, ins, pieceNames) {
  const cob = state.cob
  const line = document.createElement('div')
  line.className = 'mv-code-line'
  line.dataset.idx = String(i)
  line.dataset.offset = String(ins.offset >>> 0)
  line.dataset.script = scriptLower
  if (cob.unit.hasBreakpoint(scriptName, ins.offset)) line.classList.add('breakpointed')
  // Line-number column (leftmost).  1-based, scoped to the script
  // section so each .script restarts at 1.  Tabular numerics keep
  // the gutter from wobbling as the digit count changes.
  const lineNo = document.createElement('span')
  lineNo.className = 'mv-code-lineno'
  lineNo.textContent = String(i + 1)
  line.appendChild(lineNo)
  // PC marker column.  Empty by default; shows ▶ when the line is
  // the current PC and is draggable to set t.pc to another line.
  const pcCol = document.createElement('span')
  pcCol.className = 'mv-code-pc-marker'
  pcCol.title = 'Drag to move the program counter to another line.'
  line.appendChild(pcCol)
  // Breakpoint dot column.
  const bp = document.createElement('span')
  bp.className = 'mv-code-bp'
  bp.title = 'Click to toggle breakpoint at this instruction.'
  bp.addEventListener('click', (e) => {
    e.stopPropagation()
    if (cob.unit.hasBreakpoint(scriptName, ins.offset)) {
      cob.unit.removeBreakpoint(scriptName, ins.offset)
      line.classList.remove('breakpointed')
      // Reflect on BOS side too.
      mvSyncBosBpForOffset(state, scriptLower, ins.offset >>> 0, false)
    } else {
      cob.unit.addBreakpoint(scriptName, ins.offset)
      line.classList.add('breakpointed')
      mvSyncBosBpForOffset(state, scriptLower, ins.offset >>> 0, true)
    }
  })
  line.appendChild(bp)
  const off = document.createElement('span')
  off.className = 'mv-code-off coba-offset'
  off.textContent = '0x' + (ins.offset >>> 0).toString(16).padStart(4, '0')
  const code = document.createElement('span')
  const op = document.createElement('span')
  op.className = mvOpCategory(ins.name)
  op.textContent = ins.name
  code.appendChild(op)
  const operandText = mvFormatOperands(ins, pieceNames)
  if (operandText) {
    const opd = document.createElement('span')
    opd.className = 'coba-operand'
    opd.textContent = ' ' + operandText
    code.appendChild(opd)
  }
  line.appendChild(off)
  line.appendChild(code)
  // Mutual hover — uses the line's data-script so it works across
  // every section in the full disassembly view.
  line.addEventListener('mouseenter', () => {
    const bosLine = cob.unit._asmToBos?.get(`${scriptLower}:${i}`)
    state.hoverAsmIdx = i
    state.hoverAsmScript = scriptLower
    state.hoverLine = (bosLine !== undefined) ? bosLine : null
    applyMvThreadCodeCrossHover(state)
    redrawMvThreadCodeBrackets(state)
  })
  line.addEventListener('mouseleave', () => {
    if (state.hoverAsmIdx === i && state.hoverAsmScript === scriptLower) {
      state.hoverAsmIdx = null
      state.hoverAsmScript = null
      state.hoverLine = null
      applyMvThreadCodeCrossHover(state)
      redrawMvThreadCodeBrackets(state)
    }
  })
  return line
}

// mvSyncBosBpForOffset adds / removes .bos-bp on whichever BOS line
// the supplied offset maps back to, keeping the source pane in sync
// when a BP is toggled from the asm side.
function mvSyncBosBpForOffset(state, scriptLower, offset, on) {
  const dec = state.panel.querySelector('.mv-thread-code-decompiled')
  const map = state.cob?.runtime?._bosMap
  if (!dec || !map) return
  for (const [lineIdx, entry] of map.entries()) {
    if (entry.script.toLowerCase() !== scriptLower) continue
    if ((entry.startOffset >>> 0) !== offset) continue
    const bosEl = dec.querySelector(`div[data-line="${lineIdx}"]`)
    if (bosEl) bosEl.classList.toggle('bos-bp', on)
    return
  }
}

// drawMvJumpArrows paints arrow paths into one section's gutter SVG.
// Called once per script section after the section's lines have
// mounted (so getBoundingClientRect returns real positions).
function drawMvJumpArrows(body, svg, jumps, laneW, gutterW) {
  if (!body || !svg) return
  const lineEls = body.querySelectorAll('.mv-code-line')
  if (lineEls.length === 0) return
  const bodyRect = body.getBoundingClientRect()
  const yOf = (idx) => {
    const el = lineEls[idx]
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return ((r.top + r.bottom) * 0.5) - bodyRect.top
  }
  // Size the SVG to the section's full content height so arrows
  // pointing far down still render when the user scrolls.
  const totalH = body.scrollHeight || body.clientHeight
  svg.setAttribute('height', String(totalH))
  svg.setAttribute('width', String(gutterW || 0))
  svg.style.height = totalH + 'px'
  svg.replaceChildren()
  if (!jumps || jumps.length === 0) return
  const r = 4
  for (const j of jumps) {
    const fromY = yOf(j.fromIdx)
    const toY = yOf(j.toIdx)
    const x = (j.lane + 1) * laneW
    const right = x + 6
    const d = fromY < toY
      ? `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY + r} V ${toY - r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
      : `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY - r} V ${toY + r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.classList.add('mv-jump-arrow')
    if (j.isLoop) path.classList.add('loop')
    svg.appendChild(path)
    const ah = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
    ah.setAttribute('points', `${right},${toY} ${right - 5},${toY - 3} ${right - 5},${toY + 3}`)
    ah.classList.add('mv-jump-arrow-head')
    if (j.isLoop) ah.classList.add('loop')
    svg.appendChild(ah)
  }
}

function mvFormatOperands(ins, pieceNames) {
  // Piece-targeted ops with axis: piece name + axis letter
  const pieceAxisOps = new Set(['MOVE', 'TURN', 'SPIN', 'STOP_SPIN', 'MOVE_NOW', 'TURN_NOW', 'WAIT_FOR_TURN', 'WAIT_FOR_MOVE'])
  if (pieceAxisOps.has(ins.name)) {
    const pn = pieceNames[ins.p1] || `#${ins.p1}`
    const axis = ['x', 'y', 'z'][ins.p2 | 0] || '?'
    return `${pn}, ${axis}-axis`
  }
  // Piece-only ops
  const pieceOps = new Set(['SHOW', 'HIDE', 'CACHE', 'DONT_CACHE', 'SHADE', 'DONT_SHADE', 'DONT_SHADOW', 'EMIT_SFX', 'EXPLODE'])
  if (pieceOps.has(ins.name)) {
    const pn = pieceNames[ins.p1] || `#${ins.p1}`
    return pn
  }
  // CALL / START — index into scripts array
  if (ins.name === 'CALL_SCRIPT' || ins.name === 'START_SCRIPT') {
    return `script[${ins.p1}], ${ins.p2 | 0} args`
  }
  // PUSH_CONST + immediate ops
  if (ins.name === 'PUSH_CONST') return `${ins.p1}`
  if (ins.name === 'PUSH_LOCAL' || ins.name === 'POP_LOCAL' || ins.name === 'CREATE_LOCAL') return `L${ins.p1}`
  if (ins.name === 'PUSH_STATIC' || ins.name === 'POP_STATIC') return `global_${ins.p1}`
  if (ins.name === 'JUMP' || ins.name === 'JUMP_IF_FALSE') return `→ 0x${(ins.p1 >>> 0).toString(16)}`
  if (ins.p1 || ins.p2) return `${ins.p1}${ins.p2 ? `, ${ins.p2}` : ''}`
  return ''
}

export function refreshMvThreadCodeHighlight(state) {
  if (!state) return
  const panel = state.panel
  const thread = state.cob.unit._threads.find((t) => t.id === state.threadId && !t.dead)
  const statusEl = panel.querySelector('.mv-exec-status')
  const pcEl = panel.querySelector('.mv-exec-pc')
  const offsetEl = panel.querySelector('.mv-exec-offset')
  // Helper that picks the colour class for the status text from a
  // short string key (run/sleep/wait/bp/dead) so the user reads the
  // execution state at a glance.
  const setStatus = (text, cls) => {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.classList.remove('status-run', 'status-sleep', 'status-wait', 'status-bp', 'status-dead')
    if (cls) statusEl.classList.add(cls)
  }
  // Sync the pause label to the runtime's actual state — covers the
  // case where a breakpoint auto-pauses the runtime (the button
  // wasn't clicked, but the label needs to flip to "▶ Resume").
  const pauseBtn = panel.querySelector('.mv-thread-code-pause')
  if (pauseBtn) {
    const wantTxt = state.cob.runtime.paused ? '▶ Resume' : '⏸ Pause'
    if (pauseBtn.textContent !== wantTxt) {
      pauseBtn.textContent = wantTxt
      pauseBtn.title = state.cob.runtime.paused
        ? 'Resume the runtime — all threads and animators resume ticking.'
        : 'Pause or resume the entire COB runtime — animators and all threads freeze.'
    }
  }
  if (!thread) {
    setStatus('terminated', 'status-dead')
    if (pcEl) pcEl.textContent = '—'
    if (offsetEl) offsetEl.textContent = '—'
    // Clear PC highlight when thread dies.
    for (const el of panel.querySelectorAll('.mv-thread-code-source .mv-code-line.pc')) el.classList.remove('pc')
    hostCallbacks.renderMvThreadCodeLocals?.(state, null)
    return
  }
  // Title tracks the current script for the user's convenience even
  // though every script is rendered in the asm pane.  No re-render
  // on CALL_SCRIPT — the new script is already drawn elsewhere.
  const src = panel.querySelector('.mv-thread-code-source')
  if (src && src.dataset.scriptName !== thread.script.name) {
    src.dataset.scriptName = thread.script.name
    const title = panel.querySelector('.mv-thread-code-title')
    if (title) title.textContent = `Thread #${thread.id} · ${thread.script.name}`
  }
  // Status row — sleep / wait / running / BP-paused (auto-pause).
  // The runtime-wide `paused` flag set by a BP hit takes priority so
  // the user knows execution stopped because of a breakpoint, not a
  // sleep timer.
  if (state.cob.runtime.paused && thread.breakpointHit) {
    setStatus('paused at breakpoint', 'status-bp')
  } else if (thread.sleepMs > 0) {
    setStatus(`sleeping ${Math.round(thread.sleepMs)} ms`, 'status-sleep')
  } else if (thread.waitOn) {
    setStatus(`waiting for ${thread.waitOn.type}`, 'status-wait')
  } else {
    setStatus(state.cob.runtime.paused ? 'paused' : 'running',
              state.cob.runtime.paused ? 'status-dead' : 'status-run')
  }
  // PC row — instruction index + offset.  Offset reads from the
  // current instruction (or `—` past end of script).
  const ins = thread.script.instructions[thread.pc]
  if (pcEl) pcEl.textContent = `#${thread.pc}`
  if (offsetEl) offsetEl.textContent = ins ? ('0x' + (ins.offset >>> 0).toString(16).padStart(4, '0')) : '—'
  // Update PC class on lines — scoped by data-script so the same idx
  // in two different scripts doesn't both light up.
  let prevPc = null
  for (const el of panel.querySelectorAll('.mv-thread-code-source .mv-code-line.pc')) {
    prevPc = el
    el.classList.remove('pc')
  }
  const fnLower = thread.script.name.toLowerCase()
  const target = panel.querySelector(`.mv-thread-code-source .mv-code-line[data-script="${fnLower}"][data-idx="${thread.pc}"]`)
  if (target) {
    target.classList.add('pc')
    // Auto-scroll BOTH panes (asm + BOS) so the current line stays
    // centred as the thread runs.  Only fires when PC actually moves
    // — without that gate we'd be fighting user scrolls every tick.
    if (prevPc !== target) centerMvThreadPanesOnPc(state, thread, target)
  }
  hostCallbacks.renderMvThreadCodeLocals?.(state, thread)
  refreshMvThreadCodeDecompHighlight(state, thread)
}

// centerMvThreadPanesOnPc scrolls the asm pane to put the PC line at
// vertical centre AND scrolls the BOS pane to put the mapped BOS
// statement at vertical centre.  Both happen with _scrollSyncing on
// so the lockstep handlers don't fire and double-correct.
function centerMvThreadPanesOnPc(state, thread, asmTarget) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src) return
  state._scrollSyncing = true
  // Asm-side centring.  We compute scrollTop directly rather than
  // scrollIntoView — `scrollIntoView` would also scroll containing
  // panels (e.g. the panel itself), which is not what we want.
  {
    const lineEl = asmTarget
    const r = lineEl.getBoundingClientRect()
    const srcRect = src.getBoundingClientRect()
    const lineCentre = (r.top + r.bottom) * 0.5
    const srcCentre = srcRect.top + src.clientHeight / 2
    const delta = lineCentre - srcCentre
    const max = src.scrollHeight - src.clientHeight
    src.scrollTop = Math.max(0, Math.min(max, src.scrollTop + delta))
  }
  // BOS-side centring on the statement that maps to this PC.  Match
  // on script + idx range — the BOS pane spans all functions now so
  // we have to filter to the right script even though the asm-side
  // PC line carries data-script already.
  const map = state.cob.unit._bosMap
  if (dec && map) {
    let bestLine = -1
    const fnLower = thread.script.name.toLowerCase()
    for (const [lineIdx, entry] of map.entries()) {
      if (entry.script.toLowerCase() !== fnLower) continue
      if (thread.pc >= entry.startIdx && thread.pc <= entry.endIdx) {
        bestLine = lineIdx
        break
      }
    }
    if (bestLine >= 0) {
      const bosEl = dec.querySelector(`div[data-line="${bestLine}"]`)
      if (bosEl) {
        const r = bosEl.getBoundingClientRect()
        const decRect = dec.getBoundingClientRect()
        const lineCentre = (r.top + r.bottom) * 0.5
        const decCentre = decRect.top + dec.clientHeight / 2
        const delta = lineCentre - decCentre
        const max = dec.scrollHeight - dec.clientHeight
        dec.scrollTop = Math.max(0, Math.min(max, dec.scrollTop + delta))
      }
    }
  }
  // Release sync guard after the scroll events have fired so the
  // lockstep handlers don't loop back.
  // Scroll events fire asynchronously (not during scrollTop=), so a
  // microtask would release the guard before the echo arrives.  A
  // short timeout covers the typical browser scroll-event latency.
  if (state._scrollSyncResetTimer) clearTimeout(state._scrollSyncResetTimer)
  state._scrollSyncResetTimer = setTimeout(() => {
    state._scrollSyncing = false
    state._scrollSyncResetTimer = null
  }, 60)
}

// wireMvThreadCodeBrackets attaches scroll + hover + resize listeners
// for a single panel.  Idempotent via dataset.wired on each cloned
// node (each cloned panel starts fresh, no cross-bleed).
export function wireMvThreadCodeBrackets(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (src && src.dataset.bracketWired !== '1') {
    src.dataset.bracketWired = '1'
    src.addEventListener('scroll', () => {
      // Lockstep: when the user scrolls the asm pane, slide the BOS
      // pane so its current middle line maps to roughly the asm
      // middle.  Guarded against the symmetric handler with
      // _scrollSyncing so the two don't fight.
      if (!state._scrollSyncing) syncScrollFromAsm(state)
      redrawMvThreadCodeBrackets(state)
    })
    // PC-marker drag: mousedown on the ▶ marker of the active PC line
    // starts a drag.  Mousemove tracks the asm line currently under
    // the pointer; mouseup writes that line's idx back to t.pc.
    wireMvPcDrag(state)
  }
  if (dec && dec.dataset.bracketWired !== '1') {
    dec.dataset.bracketWired = '1'
    dec.addEventListener('scroll', () => {
      if (!state._scrollSyncing) syncScrollFromBos(state)
      redrawMvThreadCodeBrackets(state)
    })
    // Hover-snap: when mouse moves over a mapped BOS line, scroll
    // the assembly pane so the FIRST instruction of that line sits
    // at the same Y position as the hovered line.  Snap is
    // suppressed while the user is actively scrolling the assembly
    // pane (otherwise our scroll fights theirs).
    dec.addEventListener('mousemove', (e) => {
      const lineEl = e.target.closest('div[data-line]')
      if (!lineEl) return
      const lineIdx = parseInt(lineEl.dataset.line, 10)
      if (!Number.isFinite(lineIdx)) return
      const entry = state.cob.unit._bosMap?.get(lineIdx)
      if (!entry) {
        if (state.hoverLine !== null) {
          state.hoverLine = null
          state.hoverAsmIdx = null
          state.hoverAsmScript = null
          applyMvThreadCodeCrossHover(state)
          redrawMvThreadCodeBrackets(state)
        }
        return
      }
      if (state.hoverLine !== lineIdx) {
        state.hoverLine = lineIdx
        state.hoverAsmIdx = entry.startIdx
        state.hoverAsmScript = entry.script.toLowerCase()
        // Don't snap-scroll the asm pane any more — the lockstep sync
        // handlers + per-line PC marker handle alignment, and snap
        // would fight the user's intent when they're just hovering.
        applyMvThreadCodeCrossHover(state)
        redrawMvThreadCodeBrackets(state)
      }
    })
    dec.addEventListener('mouseleave', () => {
      if (state.hoverLine !== null) {
        state.hoverLine = null
        state.hoverAsmIdx = null
        applyMvThreadCodeCrossHover(state)
        redrawMvThreadCodeBrackets(state)
      }
    })
  }
  if (panel.dataset.resizeWired !== '1') {
    panel.dataset.resizeWired = '1'
    new ResizeObserver(() => redrawMvThreadCodeBrackets(state)).observe(panel)
  }
}

// syncScrollFromAsm — user scrolled the assembly pane; align the BOS
// pane so the BOS line mapping to the asm middle row lands on the
// BOS middle row.  Sets _scrollSyncing while writing the BOS pane's
// scrollTop so the BOS scroll handler doesn't loop back.
function syncScrollFromAsm(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  const rt = state.cob?.runtime
  if (!rt?._asmToBos || !rt._bosMap) return
  // Asm row sitting on the source pane's vertical midpoint.
  const midY = src.getBoundingClientRect().top + src.clientHeight / 2
  const lineEls = src.querySelectorAll('.mv-code-line')
  let bestI = -1, bestDist = Infinity
  for (let i = 0; i < lineEls.length; i++) {
    const r = lineEls[i].getBoundingClientRect()
    const c = (r.top + r.bottom) * 0.5
    const d = Math.abs(c - midY)
    if (d < bestDist) { bestDist = d; bestI = i }
  }
  if (bestI < 0) return
  // Walk outward from the middle line to find one that's mapped
  // (many PUSH-only asm rows have no BOS mapping; without the walk,
  // sync would no-op whenever those land on the midpoint).
  let bosLineIdx
  for (let off = 0; off < 40; off++) {
    const idxs = off === 0 ? [bestI] : [bestI - off, bestI + off]
    for (const idx of idxs) {
      if (idx < 0 || idx >= lineEls.length) continue
      const el = lineEls[idx]
      const asmIdx = parseInt(el.dataset.idx, 10)
      const asmScript = el.dataset.script
      const m = rt._asmToBos.get(`${asmScript}:${asmIdx}`)
      if (m !== undefined) { bosLineIdx = m; break }
    }
    if (bosLineIdx !== undefined) break
  }
  if (bosLineIdx === undefined) return
  const bosEl = dec.querySelector(`div[data-line="${bosLineIdx}"]`)
  if (!bosEl) return
  // Centre that BOS line within the BOS pane.
  const decRect = dec.getBoundingClientRect()
  const bosRect = bosEl.getBoundingClientRect()
  const bosCentre = (bosRect.top + bosRect.bottom) * 0.5
  const decCentre = decRect.top + dec.clientHeight / 2
  const delta = bosCentre - decCentre
  const max = dec.scrollHeight - dec.clientHeight
  const next = Math.max(0, Math.min(max, dec.scrollTop + delta))
  if (Math.abs(next - dec.scrollTop) < 1) return
  state._scrollSyncing = true
  dec.scrollTop = next
  // Release on the next microtask so the scroll event has fired.
  // Scroll events fire asynchronously (not during scrollTop=), so a
  // microtask would release the guard before the echo arrives.  A
  // short timeout covers the typical browser scroll-event latency.
  if (state._scrollSyncResetTimer) clearTimeout(state._scrollSyncResetTimer)
  state._scrollSyncResetTimer = setTimeout(() => {
    state._scrollSyncing = false
    state._scrollSyncResetTimer = null
  }, 60)
}

// syncScrollFromBos — symmetric: user scrolled BOS pane, slide asm
// pane so the asm chunk mapped to the BOS middle line centres in the
// source pane.
function syncScrollFromBos(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  const rt = state.cob?.runtime
  if (!rt?._bosMap) return
  const midY = dec.getBoundingClientRect().top + dec.clientHeight / 2
  let bestEl = null, bestDist = Infinity
  for (const el of dec.children) {
    if (!el.dataset || el.dataset.line === undefined) continue
    const r = el.getBoundingClientRect()
    const c = (r.top + r.bottom) * 0.5
    const d = Math.abs(c - midY)
    if (d < bestDist) { bestDist = d; bestEl = el }
  }
  if (!bestEl) return
  const bosLineIdx = parseInt(bestEl.dataset.line, 10)
  // Walk outward from the centred BOS line to find one with a mapping
  // (blank lines + comments don't have entries; without this walk, the
  // sync would no-op whenever the centred line happens to be unmapped).
  // The BOS pane spans ALL scripts now, so the matched entry tells us
  // which asm section to align to.
  let entry = null
  for (let off = 0; off < 60; off++) {
    const idxs = off === 0 ? [bosLineIdx] : [bosLineIdx - off, bosLineIdx + off]
    for (const idx of idxs) {
      const e = rt._bosMap.get(idx)
      if (e) { entry = e; break }
    }
    if (entry) break
  }
  if (!entry) return
  const asmEl = src.querySelector(`.mv-code-line[data-script="${entry.script.toLowerCase()}"][data-idx="${entry.startIdx}"]`)
  if (!asmEl) return
  const srcRect = src.getBoundingClientRect()
  const asmRect = asmEl.getBoundingClientRect()
  const asmCentre = (asmRect.top + asmRect.bottom) * 0.5
  const srcCentre = srcRect.top + src.clientHeight / 2
  const delta = asmCentre - srcCentre
  const max = src.scrollHeight - src.clientHeight
  const next = Math.max(0, Math.min(max, src.scrollTop + delta))
  if (Math.abs(next - src.scrollTop) < 1) return
  state._scrollSyncing = true
  src.scrollTop = next
  // Scroll events fire asynchronously (not during scrollTop=), so a
  // microtask would release the guard before the echo arrives.  A
  // short timeout covers the typical browser scroll-event latency.
  if (state._scrollSyncResetTimer) clearTimeout(state._scrollSyncResetTimer)
  state._scrollSyncResetTimer = setTimeout(() => {
    state._scrollSyncing = false
    state._scrollSyncResetTimer = null
  }, 60)
}

// redrawMvThreadCodeBrackets paints the SVG bracket overlay.  Walks
// the VISIBLE BOS lines, finds each mapped line's assembly range,
// and emits a cubic-bezier path connecting the BOS line midpoint
// to the assembly chunk midpoint.  Special classes mark the
// currently-PC'd line + any breakpointed lines + the hover line.
// Throttled implicitly by the inspector's 4 Hz tick + scroll
// debouncing the browser already does.
// Draws curved connectors between each visible assembly instruction
// and its matching BOS line.  One curve per asm line — many curves
// converge on the same BOS line when a single statement compiled to
// multiple ops.  No rectangular {-shape brackets any more (the user
// asked for "just lines from each displayed assembly line flow to
// their corresponding code text line").  Visible only inside the
// gutter strip between the two panes.
export function redrawMvThreadCodeBrackets(state) {
  if (!state) return
  const panel = state.panel
  const svg = panel.querySelector('.mv-thread-code-brackets')
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!svg || !src || !dec || !state.cob.unit._bosMap) return
  const body = svg.parentElement
  const bodyRect = body.getBoundingClientRect()
  svg.setAttribute('viewBox', `0 0 ${bodyRect.width} ${bodyRect.height}`)
  svg.setAttribute('width', String(bodyRect.width))
  svg.setAttribute('height', String(bodyRect.height))
  svg.replaceChildren()
  const decRect = dec.getBoundingClientRect()
  const srcRect = src.getBoundingClientRect()
  // The two panes sit flush against each other (zero margin between
  // them), so srcRect.right === decRect.left.  Anchoring the curves
  // at the pane edges would collapse them to a single vertical line.
  // Instead we anchor INSIDE each pane's reserved-gutter padding:
  //   asm has padding-right: 28px → anchor 6 px in from the right
  //   dec has padding-left:  28px → anchor 6 px in from the left
  // That gives ~44 px of horizontal travel even with flush panes.
  const GUTTER_INSET = 22
  const endX   = srcRect.right - bodyRect.left - GUTTER_INSET   // asm side
  const startX = decRect.left  - bodyRect.left + GUTTER_INSET   // dec side
  const mid    = (startX + endX) * 0.5
  const thread = state.cob.unit._threads.find((t) => t.id === state.threadId && !t.dead)
  const pcScript = thread?.script?.name?.toLowerCase()
  const pcIdx = thread ? thread.pc : -1
  const bps = state.cob.unit._breakpoints
  const asmToBos = state.cob.unit._asmToBos
  if (!asmToBos) return
  for (const asmEl of src.querySelectorAll('.mv-code-line')) {
    const asmRect = asmEl.getBoundingClientRect()
    if (asmRect.bottom < srcRect.top - 4 || asmRect.top > srcRect.bottom + 4) continue
    const asmIdx = parseInt(asmEl.dataset.idx, 10)
    const asmScript = asmEl.dataset.script
    if (!Number.isFinite(asmIdx) || !asmScript) continue
    const bosLineIdx = asmToBos.get(`${asmScript}:${asmIdx}`)
    if (bosLineIdx === undefined) continue
    const entry = state.cob.unit._bosMap.get(bosLineIdx)
    if (!entry) continue
    const bosEl = dec.querySelector(`div[data-line="${bosLineIdx}"]`)
    if (!bosEl) continue
    const bosRect = bosEl.getBoundingClientRect()
    if (bosRect.bottom < decRect.top - 4 || bosRect.top > decRect.bottom + 4) continue
    const asmY = (asmRect.top + asmRect.bottom) * 0.5 - bodyRect.top
    const bosY = (bosRect.top + bosRect.bottom) * 0.5 - bodyRect.top
    const asmYClamped = Math.max(srcRect.top - bodyRect.top, Math.min(srcRect.bottom - bodyRect.top, asmY))
    const bosYClamped = Math.max(decRect.top - bodyRect.top, Math.min(decRect.bottom - bodyRect.top, bosY))
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    const d = `M ${endX} ${asmYClamped} C ${mid} ${asmYClamped}, ${mid} ${bosYClamped}, ${startX} ${bosYClamped}`
    path.setAttribute('d', d)
    const isPc = asmScript === pcScript && asmIdx === pcIdx
    const isBp = bps.has(`${asmScript}:${entry.startOffset >>> 0}`)
    const isHover = (state.hoverLine === bosLineIdx) ||
                    (state.hoverAsmIdx === asmIdx && state.hoverAsmScript === asmScript)
    if (isHover) path.classList.add('hover')
    else if (isPc) path.classList.add('pc')
    else if (isBp) path.classList.add('bp')
    svg.appendChild(path)
  }
}

// wireMvPcDrag wires two ways to set the program counter from the
// debugger:
//   1. Click any line's PC marker → set PC to that line.
//   2. Drag the green ▶ on the active PC line → drop on any other
//      line to set PC there.
// Implemented with Pointer Events + setPointerCapture so events keep
// firing even when the pointer leaves the marker mid-drag.  Click vs
// drag is decided by whether the pointer moved > 3 px before release.
function wireMvPcDrag(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  if (!src) return
  let dragging = false
  let dragGhost = null
  let activePointerId = null
  let armedMarker = null
  let armedAtClient = null
  const moveGhost = (x, y) => {
    if (!dragGhost) return
    dragGhost.style.left = (x + 10) + 'px'
    dragGhost.style.top = (y - 8) + 'px'
  }
  const clearDropHighlight = () => {
    for (const el of src.querySelectorAll('.mv-code-line.pc-drop')) el.classList.remove('pc-drop')
  }
  src.addEventListener('pointerdown', (e) => {
    const marker = e.target.closest('.mv-code-pc-marker')
    if (!marker) return
    e.preventDefault(); e.stopPropagation()
    armedMarker = marker
    armedAtClient = { x: e.clientX, y: e.clientY }
    activePointerId = e.pointerId
    try { marker.setPointerCapture(e.pointerId) } catch { /* not supported in some test envs */ }
  })
  src.addEventListener('pointermove', (e) => {
    if (activePointerId !== e.pointerId || !armedMarker) return
    if (!dragging) {
      // Promote to drag once the pointer travels > 3 px — otherwise
      // every casual click would flash a ghost arrow.
      const dx = e.clientX - armedAtClient.x
      const dy = e.clientY - armedAtClient.y
      if (dx * dx + dy * dy < 9) return
      dragging = true
      panel.classList.add('pc-dragging')
      dragGhost = document.createElement('div')
      dragGhost.className = 'mv-code-pc-ghost'
      dragGhost.textContent = '▶'
      document.body.appendChild(dragGhost)
    }
    moveGhost(e.clientX, e.clientY)
    clearDropHighlight()
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mv-code-line')
    if (target && src.contains(target)) target.classList.add('pc-drop')
  })
  src.addEventListener('pointerup', (e) => {
    if (activePointerId !== e.pointerId) return
    const wasDragging = dragging
    if (wasDragging) {
      clearDropHighlight()
      if (dragGhost) { dragGhost.remove(); dragGhost = null }
      panel.classList.remove('pc-dragging')
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mv-code-line')
      if (target && src.contains(target)) mvSetThreadPc(state, target)
    } else if (armedMarker) {
      // No motion → treat as click.  Sets PC to the clicked line
      // regardless of whether it's the previous active PC line.
      const line = armedMarker.closest('.mv-code-line')
      if (line) mvSetThreadPc(state, line)
    }
    try { armedMarker?.releasePointerCapture(e.pointerId) } catch { /* fine */ }
    dragging = false
    armedMarker = null
    armedAtClient = null
    activePointerId = null
  })
  src.addEventListener('pointercancel', () => {
    dragging = false
    armedMarker = null
    armedAtClient = null
    activePointerId = null
    panel.classList.remove('pc-dragging')
    if (dragGhost) { dragGhost.remove(); dragGhost = null }
    clearDropHighlight()
  })
}

// mvSetThreadPc writes (script, pc) → thread, clears any sleep/wait
// so execution can resume from the new spot, and refreshes the panel.
// Looks the thread up via CobRuntime.findThreadById — the runtime is
// now multi-unit, so a flat rt._threads.find no longer works (threads
// live on the unit, not the runtime).  Script tables (scriptNames /
// scripts) also live on the owning unit.
function mvSetThreadPc(state, lineEl) {
  const newIdx = parseInt(lineEl.dataset.idx, 10)
  const newScript = lineEl.dataset.script
  if (!Number.isFinite(newIdx) || !newScript) return
  const rt = state.cob?.runtime
  if (!rt || typeof rt.findThreadById !== 'function') return
  const found = rt.findThreadById(state.threadId)
  if (!found) return
  const { thread: t, unit: u } = found
  if (newScript !== t.script.name.toLowerCase()) {
    const sIdx = u.scriptNames.findIndex((n) => n && n.toLowerCase() === newScript)
    if (sIdx >= 0 && u.scripts[sIdx]) t.script = u.scripts[sIdx]
  }
  t.pc = newIdx
  t.sleepMs = 0
  t.waitOn = null
  t.breakpointHit = false
  refreshMvThreadCodeHighlight(state)
}
