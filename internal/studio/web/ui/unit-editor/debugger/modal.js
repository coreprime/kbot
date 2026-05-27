// modal.js
//
// Lifecycle for the thread-code-view debugger panel.  Each open
// debugger is a Preact mount of the <ThreadDebugger> component into
// a per-thread <div> host appended to the model-viewer dialog.  The
// component wraps the shared FloatingPanel chrome (drag, resize,
// persisted position + size, sidebar, minimize, header extras) around
// the existing imperative renderers (asm pane / BOS pane / brackets
// / locals tray) so the refresh tick + cross-pane logic keep working
// unchanged.
//
// What lives here:
//
//   - _mvThreadCodePanels — Map<threadId, state> of every open
//     debugger.  Iterated by the refresh tick (refresh-tick.js) to
//     repaint PC + locals.  The component populates the entry on
//     mount and removes it on unmount; the helpers below interact
//     with it via mount/unmount lifecycle.
//   - openMvThreadCodeModal(cob, thread) — opens (or focuses) a
//     debugger for the given thread.  Idempotent per thread id —
//     repeated clicks bring the existing panel to the front.
//   - closeMvThreadCodeModal(state) — tear down one debugger.
//   - closeAllMvThreadCodePanels() — tab-switch teardown.
//   - bringMvThreadCodePanelToFront(state) — z-index bump.
//   - applyMvThreadCodeSearch(state, query) — pane search highlight
//     used by the React component's search input.  Lives here so
//     the existing import path from refresh-tick + bos.js stays
//     unchanged.

import { render } from 'preact'
import { htm as html } from '/ui/common/htm-bind.js'
import { setPanelVisible } from '/ui/common/panel-store.js'
import { subscribeTick } from '/ui/common/refresh-tick.js'
import {
  refreshMvThreadCodeHighlight,
  redrawMvThreadCodeBrackets,
} from './asm.js'

// Keyed by thread id → per-panel imperative state blob.  Populated
// by ThreadDebugger's first useEffect; removed on unmount.
export const _mvThreadCodePanels = new Map()

// Per-tick refresh — subscribe once at module load so refresh-tick.js
// can fire a generic 'tick' signal without knowing about the unit
// editor's debugger.  No-op when there are no panels open.
subscribeTick(() => {
  for (const state of _mvThreadCodePanels.values()) {
    refreshMvThreadCodeHighlight(state)
    redrawMvThreadCodeBrackets(state)
    _refreshCoverageDim(state)
  }
})

// _refreshCoverageDim strips the .mv-code-unexecuted / .bos-unexecuted
// class from any debugger line whose offset has been executed since
// the debugger opened.  Cheap: only touches the lines we previously
// dimmed (querySelectorAll over `.mv-code-unexecuted` is bounded by
// the unexecuted set, which shrinks toward zero as the script's hot
// paths run).  When a previously-dormant function (walk, FireWeapon1,
// ...) finally gets called, its lines brighten on the next refresh
// tick so the user can see at a glance "this code is reachable now."
function _refreshCoverageDim(state) {
  const panel = state.panel
  if (!panel) return
  const cov = state.cob?.unit?._executedOffsets
  if (!cov || cov.size === 0) return
  const dimAsm = panel.querySelectorAll('.mv-thread-code-source .mv-code-line.mv-code-unexecuted')
  for (const line of dimAsm) {
    const scr = line.dataset.script
    const off = parseInt(line.dataset.offset, 10)
    if (!scr || !Number.isFinite(off)) continue
    const s = cov.get(scr)
    if (s && s.has(off >>> 0)) line.classList.remove('mv-code-unexecuted')
  }
  const dimBos = panel.querySelectorAll('.mv-thread-code-decompiled > div.bos-unexecuted')
  for (const line of dimBos) {
    const scr = line.dataset.bosScript
    const off = parseInt(line.dataset.bosOffset, 10)
    if (!scr || !Number.isFinite(off)) continue
    const s = cov.get(scr)
    if (s && s.has(off >>> 0)) line.classList.remove('bos-unexecuted')
  }
}

// _mvThreadCodeHosts — Map<threadId, { host, panelId }>.  We track
// the React mount host separately from the state blob so we can
// re-render with a new cob/thread (focus an existing panel) or
// unmount cleanly on close.  Hosts are detached from the DOM on
// close + the React tree is torn down so component unmount effects
// run (drops the _mvThreadCodePanels entry).
const _mvThreadCodeHosts = new Map()

// _cascadeCount — increments each time a panel opens so subsequent
// debuggers offset down/right from the previous to avoid stacking
// directly on top.  Wraps every 8 to keep things on-screen.
let _cascadeCount = 0

// openMvThreadCodeModal opens (or focuses) a debugger panel for the
// given thread.  If a panel already exists for this thread id it
// rises to the top — clicking the same thread twice doesn't pile
// up duplicates.  Otherwise a fresh host + React mount lands at a
// cascading position relative to prior debuggers.
export function openMvThreadCodeModal(cob, thread) {
  const existing = _mvThreadCodePanels.get(thread.id)
  if (existing) {
    bringMvThreadCodePanelToFront(existing)
    // Re-flip the visibility signal in case the user closed and the
    // host is still mounted but hidden.
    setPanelVisible(`mv-thread-code-${thread.id}`, true)
    return
  }
  // Per-thread mount host — appended inside `.model-viewer-stage`
  // so (a) the panel inherits the dialog's display:none on tab
  // switch and (b) the FloatingPanel drag clamp (which reads
  // .model-viewer-stage's rect) keeps the header inside the
  // rendering area.  Falls back to model-viewer-dialog and then
  // document.body if the stage isn't laid out yet (defensive — the
  // dialog template always provides it in practice).
  const stage = document.querySelector('.model-viewer-stage')
    || document.getElementById('model-viewer-dialog')
    || document.body
  const host = document.createElement('div')
  host.className = 'mv-thread-code-mount'
  host.dataset.threadId = String(thread.id)
  stage.appendChild(host)
  const panelId = `mv-thread-code-${thread.id}`
  const cascadeOffset = (_cascadeCount % 8) * 30
  _cascadeCount++
  _mvThreadCodeHosts.set(thread.id, { host, panelId })
  // Async-import ThreadDebugger so this module doesn't pull preact
  // into every page that imports openMvThreadCodeModal — only
  // mounting a panel for the first time pays the import cost.
  import('./thread-debugger.js').then(({ ThreadDebugger }) => {
    render(html`<${ThreadDebugger} cob=${cob} thread=${thread} panelId=${panelId} cascadeOffset=${cascadeOffset} />`, host)
    // Make sure the panel-store visibility signal is on — even if a
    // prior session left it false in persistence.
    setPanelVisible(panelId, true)
    // Front-most z-index so the new debugger lands on top.
    const state = _mvThreadCodePanels.get(thread.id)
    if (state) bringMvThreadCodePanelToFront(state)
  })
}

// bringMvThreadCodePanelToFront tops the z-order of the chosen
// panel.  Called on initial open + when re-opening an existing panel.
// Bumps z-index above whatever the highest currently-open panel is.
export function bringMvThreadCodePanelToFront(state) {
  if (!state || !state.panel) return
  let top = 6000
  for (const s of _mvThreadCodePanels.values()) {
    if (!s.panel) continue
    const z = parseInt(s.panel.style.zIndex || '6000', 10)
    if (z > top) top = z
  }
  state.panel.style.zIndex = String(top + 1)
}

// closeMvThreadCodeModal tears down one debugger — unmounts the
// React tree (which runs the component's cleanup effect and drops
// the _mvThreadCodePanels entry) then removes the host node.
export function closeMvThreadCodeModal(state) {
  if (!state) return
  const entry = _mvThreadCodeHosts.get(state.threadId)
  if (!entry) {
    // Component already unmounted — just guarantee the map is clean.
    _mvThreadCodePanels.delete(state.threadId)
    return
  }
  render(null, entry.host)   // unmount the React tree
  entry.host.remove()
  _mvThreadCodeHosts.delete(state.threadId)
  _mvThreadCodePanels.delete(state.threadId)
}

// closeAllMvThreadCodePanels tears down every open debugger.  Called
// on tab switch so a debugger opened in tab A isn't left pointing at
// tab A's now-stale runtime once tab B becomes active.
export function closeAllMvThreadCodePanels() {
  for (const state of [..._mvThreadCodePanels.values()]) closeMvThreadCodeModal(state)
  // Defensive: any orphan host entries (component unmounted without
  // a state to chase) get cleared too.
  for (const [, entry] of _mvThreadCodeHosts) {
    render(null, entry.host)
    entry.host.remove()
  }
  _mvThreadCodeHosts.clear()
}

// applyMvThreadCodeSearch lights up every line in either pane whose
// text contains the query.  Case-insensitive substring match; empty
// query clears all marks.  Matches use a class (not a DOM rewrite)
// so existing syntax-highlight spans stay intact.
//
// Lives here so the existing import paths from refresh-tick +
// bos.js + thread-debugger.js all reach a single canonical
// implementation.
export function applyMvThreadCodeSearch(state, query) {
  const panel = state.panel
  if (!panel) return
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
