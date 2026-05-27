// modal.js
//
// Lifecycle + chrome for the thread-code-view debugger.  Each open
// panel is a clone of the `#mv-thread-code-template` <template>
// element, populated for one specific thread (so you can keep
// multiple debuggers open side-by-side, each tracking its own
// thread's PC + locals + scrolls).
//
// What lives here:
//
//   - _mvThreadCodePanels — the Map<threadId, state> of every open
//     debugger panel; exported so the inspector-refresh tick + the
//     decompile-fetch callback in studio.js can iterate it
//   - openMvThreadCodeModal(cob, thread) — clones the template,
//     cascades position, populates initial source + decomp via the
//     hostCallbacks render functions, raises to front
//   - bringMvThreadCodePanelToFront(state) — z-index bump
//   - closeMvThreadCodeModal(state) — abort listeners + remove DOM
//   - closeAllMvThreadCodePanels() — tab-switch teardown
//   - wireMvThreadCodeChrome(state) — close / pause / step buttons,
//     drag handler, 8-direction resize, minimize, vars-collapse,
//     section toggles, search box (Ctrl/Cmd+F focus)
//   - applyMvThreadCodeSearch(state, query) — highlight matching
//     lines in both panes, scroll first match into view
//
// What still lives in studio.js (moves in R43d/e):
//
//   - renderMvThreadCodeSource / Decompiled (BOS + asm renderers)
//   - wireMvThreadCodeBrackets (bracket curve overlay wiring)
//   - refreshMvThreadCodeHighlight (per-tick PC highlight + locals)
//   - redrawMvThreadCodeBrackets (bracket repaint after resize)
//
// All four are reached through hostCallbacks so this module never
// imports from studio.js.

import { clamp, hostCallbacks } from '../../host-context.js'

// Keyed by thread id → per-panel state.  Multiple debugger panels
// can be open simultaneously; each clones the template and tracks
// its own hover/pc/locals scope.  Iterated by the inspector tick
// (refreshMvInspectors) so each window updates independently.
export const _mvThreadCodePanels = new Map()

// openMvThreadCodeModal opens (or focuses) a debugger panel for the
// given thread.  If a panel already exists for this thread id it
// just rises to the top — clicking the same thread twice doesn't
// pile up duplicates.  Otherwise a fresh template instance is cloned,
// cascaded ~30px down/right from the previous to keep both visible.
export function openMvThreadCodeModal(cob, thread) {
  const existing = _mvThreadCodePanels.get(thread.id)
  if (existing) {
    bringMvThreadCodePanelToFront(existing)
    return
  }
  const tpl = document.getElementById('mv-thread-code-template')
  if (!tpl) return
  const node = tpl.content.firstElementChild.cloneNode(true)
  node.dataset.threadId = String(thread.id)
  // Cascade — each new panel offsets from the prior so they don't
  // perfectly overlap.  Wraps every 8 to keep things on-screen.
  const slot = _mvThreadCodePanels.size
  const cascade = (slot % 8) * 30
  node.style.left = (360 + cascade) + 'px'
  node.style.top = (120 + cascade) + 'px'
  // Mount inside the model viewer dialog so the panel inherits its
  // display:none when the user switches to a non-model tab — without
  // this, fixed-position panels stayed pinned to the viewport across
  // map tabs.  Falls back to document.body if the dialog isn't
  // rendered yet (defensive — shouldn't happen in normal use).
  const host = document.getElementById('model-viewer-dialog') || document.body
  host.appendChild(node)
  // AbortController scopes the panel's window-level drag/resize
  // listeners so closing one debugger cleanly removes its handlers
  // (rather than leaking one set per ever-opened panel).
  const ac = new AbortController()
  const state = { panel: node, cob, threadId: thread.id, hoverLine: null, hoverAsmIdx: null, abort: ac }
  _mvThreadCodePanels.set(thread.id, state)
  bringMvThreadCodePanelToFront(state)
  wireMvThreadCodeChrome(state)
  hostCallbacks.renderMvThreadCodeSource?.(state, thread)
  hostCallbacks.renderMvThreadCodeDecompiled?.(state, cob)
  hostCallbacks.wireMvThreadCodeBrackets?.(state)
  hostCallbacks.refreshMvThreadCodeHighlight?.(state)
  hostCallbacks.redrawMvThreadCodeBrackets?.(state)
}

// bringMvThreadCodePanelToFront tops the z-order of the chosen
// panel.  Called on initial open + on every header pointerdown.
// Bumps z-index relative to the highest currently-open panel so
// clicks always raise the focused one.
export function bringMvThreadCodePanelToFront(state) {
  let top = 6000
  for (const s of _mvThreadCodePanels.values()) {
    const z = parseInt(s.panel.style.zIndex || '6000', 10)
    if (z > top) top = z
  }
  state.panel.style.zIndex = String(top + 1)
}

export function closeMvThreadCodeModal(state) {
  if (!state) return
  state.abort?.abort()
  state.panel.remove()
  _mvThreadCodePanels.delete(state.threadId)
}

// closeAllMvThreadCodePanels tears down every open debugger panel.
// Called on tab switch so a debugger opened in tab A isn't left
// pointing at tab A's now-stale runtime once tab B becomes active.
export function closeAllMvThreadCodePanels() {
  for (const state of [..._mvThreadCodePanels.values()]) closeMvThreadCodeModal(state)
}

// wireMvThreadCodeChrome attaches per-panel handlers — close, pause,
// step, drag, resize, vars-collapse.  Idempotent via dataset.wired
// (each cloned node starts unwired so flags don't bleed across).
export function wireMvThreadCodeChrome(state) {
  const panel = state.panel
  const closeBtn = panel.querySelector('.mv-thread-code-close')
  if (closeBtn) closeBtn.addEventListener('click', () => closeMvThreadCodeModal(state))
  // Pause/resume the entire runtime.  Icon swaps ⏸↔▶ so the user
  // sees what the click WILL do (current state visible as label).
  const pauseBtn = panel.querySelector('.mv-thread-code-pause')
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      const rt = state.cob?.runtime
      if (!rt) return
      rt.setPaused(!rt.paused)
      pauseBtn.textContent = rt.paused ? '▶' : '⏸'
      pauseBtn.title = rt.paused ? 'Resume the runtime.' : 'Pause / resume the entire runtime.'
    })
  }
  // Step past a hit breakpoint — KEEP the thread's breakpointHit flag
  // set so _runThread reads `allowFirstBreakpoint=false`, skipping the
  // BP check for the very first instruction this tick (executing the
  // BP'd line once) before resuming normal BP checking.  We briefly
  // unpause the runtime, tick once, then leave it paused again so the
  // user can keep stepping or hit Resume to keep going.  Clearing
  // breakpointHit (the old behaviour) caused the BP to immediately
  // re-trigger on the same line, defeating the step.
  const stepBtn = panel.querySelector('.mv-thread-code-step')
  if (stepBtn) {
    stepBtn.addEventListener('click', () => {
      const rt = state.cob?.runtime
      if (!rt || typeof rt.findThreadById !== 'function') return
      const found = rt.findThreadById(state.threadId)
      if (!found) return
      const t = found.thread
      // Clear any pending sleep/wait so the next instruction runs
      // (the user pressed Step — they don't want to wait out timers).
      if (t.sleepMs > 0) t.sleepMs = 0
      if (t.waitOn) t.waitOn = null
      // Advance exactly one bytecode instruction.  No animator tick —
      // user can watch e.g. stack pushes accumulate before a CALL.
      rt.stepOne(state.threadId)
      // Stay paused after the step so the user can step again.
      rt.paused = true
      if (pauseBtn) {
        pauseBtn.textContent = '▶'
        pauseBtn.title = 'Resume the runtime.'
      }
      // Force an immediate panel refresh so the new PC + locals/stack
      // values are visible without waiting for the next 4 Hz tick.
      hostCallbacks.refreshMvThreadCodeHighlight?.(state)
    })
  }
  // Drag handler.  Reads the panel's bounding rect and updates
  // position via inline left/top so subsequent layout doesn't fight.
  // Header pointerdown also raises the panel above its siblings so
  // overlapping debuggers focus cleanly on click.
  const sig = state.abort?.signal
  const header = panel.querySelector('.mv-thread-code-header')
  if (header) {
    let dragOff = null
    header.addEventListener('mousedown', (e) => {
      bringMvThreadCodePanelToFront(state)
      // Don't claim mousedown when the user is interacting with a
      // form control or a chrome button.  Calling preventDefault on
      // an input mousedown would block focus, which is exactly why
      // the search box stopped accepting typing.
      if (e.target.closest('button, input, select, textarea')) return
      e.preventDefault()
      const r = panel.getBoundingClientRect()
      dragOff = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      header.classList.add('dragging')
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragOff) return
      const left = clamp(e.clientX - dragOff.dx, 0, window.innerWidth - 100)
      const top = clamp(e.clientY - dragOff.dy, 0, window.innerHeight - 60)
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
    }, { signal: sig })
    window.addEventListener('mouseup', () => {
      if (!dragOff) return
      dragOff = null
      header.classList.remove('dragging')
    }, { signal: sig })
  }
  // Eight-direction resize: corners + edges.  Each handle's
  // data-resize encodes which sides the drag moves (n/s/e/w).
  // We capture the starting rect + pointer then apply per-side
  // deltas, clamping to a sensible minimum so the panel can't
  // collapse to nothing.
  let rzStart = null
  for (const handle of panel.querySelectorAll('.mv-resize')) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      const r = panel.getBoundingClientRect()
      rzStart = {
        dir: handle.dataset.resize || 'se',
        x: e.clientX, y: e.clientY,
        left: r.left, top: r.top, w: r.width, h: r.height,
      }
    })
  }
  window.addEventListener('mousemove', (e) => {
    if (!rzStart) return
    const dx = e.clientX - rzStart.x
    const dy = e.clientY - rzStart.y
    const minW = 380, minH = 220
    let { left, top, w, h } = rzStart
    if (rzStart.dir.includes('e')) w = Math.max(minW, rzStart.w + dx)
    if (rzStart.dir.includes('s')) h = Math.max(minH, rzStart.h + dy)
    if (rzStart.dir.includes('w')) {
      const newW = Math.max(minW, rzStart.w - dx)
      left = rzStart.left + (rzStart.w - newW)
      w = newW
    }
    if (rzStart.dir.includes('n')) {
      const newH = Math.max(minH, rzStart.h - dy)
      top = rzStart.top + (rzStart.h - newH)
      h = newH
    }
    panel.style.width = w + 'px'
    panel.style.height = h + 'px'
    if (rzStart.dir.includes('w')) panel.style.left = left + 'px'
    if (rzStart.dir.includes('n')) panel.style.top = top + 'px'
  }, { signal: sig })
  window.addEventListener('mouseup', () => { rzStart = null }, { signal: sig })
  // Minimize toggle — temporarily hides everything but the header.
  // Useful when the user wants the unit visible behind without
  // closing + reopening (which would lose hover/scroll state).
  const minBtn = panel.querySelector('.mv-thread-code-minimize')
  if (minBtn) {
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const minimized = panel.classList.toggle('minimized')
      minBtn.textContent = minimized ? '▢' : '_'
      minBtn.title = minimized
        ? 'Restore this debugger window to its previous size.'
        : 'Minimize this debugger window to a thin header bar (click again to restore).  State preserved.'
    })
  }
  // Variables-panel collapse toggle (now in the header).
  const varsSideToggle = panel.querySelector('.mv-thread-code-vars-side-toggle')
  if (varsSideToggle) {
    varsSideToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      panel.classList.toggle('vars-collapsed')
      varsSideToggle.textContent = panel.classList.contains('vars-collapsed') ? '▭' : '▮'
      // Bracket geometry depends on pane widths — repaint after the
      // transition settles so curves stay glued to the asm edges.
      setTimeout(() => hostCallbacks.redrawMvThreadCodeBrackets?.(state), 200)
    })
  }
  // Per-section (Locals / Globals / Stack) collapse — clicking the
  // section label toggles a class on the immediately-following list
  // so the user can hide noisy sections without losing the whole tray.
  for (const lbl of panel.querySelectorAll('.mv-thread-code-locals-label.mv-section-toggle')) {
    lbl.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = lbl.dataset.section
      const body = panel.querySelector(`[data-section-body="${key}"]`)
      if (!body) return
      const hidden = body.classList.toggle('section-hidden')
      const caret = lbl.querySelector('.mv-section-caret')
      if (caret) caret.textContent = hidden ? '▸' : '▾'
    })
  }
  // Always-visible search box — typing filters matches in both panes.
  // Esc clears + blurs.  Ctrl/Cmd+F inside the panel focuses it.
  const searchInput = panel.querySelector('.mv-thread-code-search')
  if (searchInput) {
    searchInput.addEventListener('input', () => applyMvThreadCodeSearch(state, searchInput.value))
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        searchInput.value = ''
        applyMvThreadCodeSearch(state, '')
        searchInput.blur()
      }
    })
  }
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      searchInput?.focus()
      searchInput?.select()
    }
  })
}

// applyMvThreadCodeSearch lights up every line in either pane whose
// text contains the query.  Case-insensitive substring match; empty
// query clears all marks.  Matches use a class (not a DOM rewrite)
// so existing syntax-highlight spans stay intact.
export function applyMvThreadCodeSearch(state, query) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  for (const el of src.querySelectorAll('.mv-search-match')) el.classList.remove('mv-search-match')
  for (const el of dec.querySelectorAll('.mv-search-match')) el.classList.remove('mv-search-match')
  const q = (query || '').trim().toLowerCase()
  if (!q) return
  let firstMatch = null
  for (const line of src.querySelectorAll('.mv-code-line')) {
    if (line.textContent.toLowerCase().includes(q)) {
      line.classList.add('mv-search-match')
      if (!firstMatch) firstMatch = line
    }
  }
  for (const line of dec.querySelectorAll('div[data-line]')) {
    if (line.textContent.toLowerCase().includes(q)) {
      line.classList.add('mv-search-match')
      if (!firstMatch) firstMatch = line
    }
  }
  if (firstMatch) firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
