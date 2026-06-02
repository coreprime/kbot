// thread-debugger.js
//
// React replacement for the legacy `<template id="mv-thread-code-template">`
// debugger panel.  Wires the shared FloatingPanel chrome (drag, persisted
// position + size, resizable handles, collapsible sidebar, minimize,
// custom header widgets) to the existing imperative renderers
// (renderMvThreadCodeSource / renderMvThreadCodeDecompiled /
// wireMvThreadCodeBrackets / refreshMvThreadCodeHighlight /
// renderMvThreadCodeLocals) so the per-frame refresh tick + the
// BOS↔asm cross-pane logic keep working unchanged.
//
// The body remains plain DOM — the renderers paint into refs the
// component holds, and the panel-store-backed `state` map keys by
// thread id so multiple debuggers can run side-by-side, each tracking
// its own thread.  No two-way data binding here on purpose — the
// renderers know the COB shape better than React does and rebuilding
// hundreds of asm lines from a JSX tree on every tick would be slow.
//
// Layout decisions:
//   - Uses the shared `mv-inspector-header` chrome class so the title
//     reads in the same UPPERCASE/muted style every other panel
//     uses (no bespoke .mv-thread-code-header rules any more).
//   - The header carries grip + title + Pause/Step (small icon
//     buttons) + sidebar toggle + minimize + close.  The search
//     input lives at the FAR RIGHT of the header via the
//     `headerExtras` slot with `margin-left:auto` so it pushes
//     against the chrome buttons (matches the user's request).
//   - The right sidebar uses four `CollapsibleSection` blocks
//     (Execution / Locals / Globals / Stack) so each card reads as
//     a distinct group.  The Execution card hosts the per-tick
//     status / PC / offset readouts.

import { useEffect, useRef } from 'preact/hooks'
import { signal } from '@preact/signals'
import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel, CollapsibleSection } from '@kbot/ui/floating-panel'
import { panelSignals, setPanelVisible } from '@kbot/ui/panel-store'
import { renderMvThreadCodeSource, refreshMvThreadCodeHighlight, redrawMvThreadCodeBrackets, wireMvThreadCodeBrackets } from './asm.js'
import { renderMvThreadCodeDecompiled } from './bos.js'
import { _mvThreadCodePanels, applyMvThreadCodeSearch } from './modal.js'

// _searchSignals — per-panel search-input value.  Lives outside the
// component instance so the per-tick refresh tick (which has no
// React handle) can read it back when re-painting matches after a
// PC scroll.  Keyed by panel id.
const _searchSignals = new Map()
function _searchSignal(panelId) {
  let s = _searchSignals.get(panelId)
  if (s) return s
  s = signal('')
  _searchSignals.set(panelId, s)
  return s
}

// ThreadDebugger — top-level component for one open debugger panel.
// Mounted by openMvThreadCodeModal into a per-thread <div> host that
// also acts as the React mount root (one host per thread keeps panel
// state isolated even when several debuggers run side-by-side).
export function ThreadDebugger({ cob, thread, panelId, cascadeOffset = 0 }) {
  // FloatingPanel doesn't expose a forwarded ref to its root, but it
  // does always render the aside with the supplied `id` — so we
  // resolve the root post-mount via document.getElementById.  That's
  // safe because useEffect runs after the React commit phase.
  const stateRef = useRef(null)
  const searchSig = _searchSignal(panelId)
  void searchSig.value  // subscribe so input renders the latest

  // Build the imperative state blob the legacy renderers read +
  // mutate.  Stored in stateRef so handlers (Pause / Step / search /
  // close) can reach it without a useEffect dependency churn each
  // render.
  if (!stateRef.current) {
    stateRef.current = {
      panel: null,            // populated post-mount
      cob,
      threadId: thread.id,
      hoverLine: null,
      hoverAsmIdx: null,
      hoverAsmScript: null,
      abort: new AbortController(),
    }
    _mvThreadCodePanels.set(thread.id, stateRef.current)
  }

  // Pause / Step button handlers.  Mirror the legacy versions verbatim:
  // separation of concerns — this component owns the chrome wiring,
  // the runtime owns the semantics.
  const onPauseToggle = (e) => {
    e.stopPropagation()
    const rt = cob?.runtime
    if (!rt) return
    rt.setPaused(!rt.paused)
    refreshMvThreadCodeHighlight(stateRef.current)
  }
  const onStep = (e) => {
    e.stopPropagation()
    const rt = cob?.runtime
    if (!rt || typeof rt.findThreadById !== 'function') return
    const found = rt.findThreadById(thread.id)
    if (!found) return
    const t = found.thread
    if (t.sleepMs > 0) t.sleepMs = 0
    if (t.waitOn)      t.waitOn = null
    rt.stepOne(thread.id)
    rt.paused = true
    refreshMvThreadCodeHighlight(stateRef.current)
  }
  const onSearchInput = (e) => {
    const q = e.currentTarget.value
    searchSig.value = q
    applyMvThreadCodeSearch(stateRef.current, q)
  }
  const onSearchKey = (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    searchSig.value = ''
    applyMvThreadCodeSearch(stateRef.current, '')
    e.currentTarget.blur()
  }

  // Initial-render effect.  Runs once after the React tree mounts
  // — stateRef.current.panel is now the live <aside>, so every
  // querySelector inside the renderers resolves correctly.  Also
  // registers a Ctrl/Cmd+F focus handler on the panel root.
  useEffect(() => {
    const root = document.getElementById(panelId)
    if (!root) return
    stateRef.current.panel = root
    renderMvThreadCodeSource(stateRef.current, thread)
    renderMvThreadCodeDecompiled(stateRef.current, cob)
    wireMvThreadCodeBrackets(stateRef.current)
    refreshMvThreadCodeHighlight(stateRef.current)
    redrawMvThreadCodeBrackets(stateRef.current)
    // Ctrl/Cmd+F focuses the search input.
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return
      e.preventDefault()
      const sb = root.querySelector('.mv-thread-code-search')
      sb?.focus(); sb?.select()
    }
    root.addEventListener('keydown', onKey)
    return () => {
      root.removeEventListener('keydown', onKey)
    }
  }, [cob, thread.id, thread, panelId])

  // Unmount cleanup — abort scoped listeners + drop the state entry
  // so the refresh tick stops iterating this panel.
  useEffect(() => () => {
    const s = stateRef.current
    if (!s) return
    s.abort?.abort()
    _mvThreadCodePanels.delete(thread.id)
    stateRef.current = null
  }, [thread.id])

  // Default cascade — first opener lands top-left, each subsequent
  // panel offsets down/right so multiple debuggers don't pile up.
  // Persisted position (signal) takes precedence on the next render
  // once the user drags.
  const defaultPos = { top: 60 + cascadeOffset, left: 120 + cascadeOffset }

  // Header extras — search input pushed to the right side of the
  // header via margin-left:auto so it sits flush against the chrome
  // buttons (matches the user's request that "search should be on
  // the right of the bar, not the left").  The button-stop handlers
  // prevent the drag handler from claiming the mousedown.
  const headerExtras = html`
    <input class="mv-thread-code-search" type="search"
           placeholder="Search…"
           value=${searchSig.value}
           onInput=${onSearchInput}
           onKeyDown=${onSearchKey}
           onClick=${(e) => e.stopPropagation()}
           onMouseDown=${(e) => e.stopPropagation()} />
  `

  // Sidebar tray — Execution / Locals / Globals / Stack as
  // collapsible CARDS (the body / header CSS gives each section the
  // bordered card treatment that the legacy debugger had).
  //
  // Execution card hosts the per-tick Status / PC / Offset readouts
  // AND the Pause + Step buttons.  The buttons LIVE INSIDE THE
  // EXECUTION SECTION, not the header — the user asked for them to
  // be there as neatly formatted small buttons next to the status.
  // refreshMvThreadCodeHighlight populates the status spans on each
  // 4 Hz tick (or directly after a Step click).
  const isPaused = !!cob?.runtime?.paused
  const sidebar = html`
    <div class="mv-thread-code-locals-panel">
      <${CollapsibleSection} title="Execution" panelId=${panelId} sectionKey="exec" defaultCollapsed=${false} bodyClass="mv-collapsible-body mv-thread-code-execution">
        <div class="mv-exec-row">
          <span class="mv-exec-k">Status</span>
          <span class="mv-exec-status">—</span>
        </div>
        <div class="mv-exec-row">
          <span class="mv-exec-k">PC</span>
          <span class="mv-exec-pc">—</span>
        </div>
        <div class="mv-exec-row">
          <span class="mv-exec-k">Offset</span>
          <span class="mv-exec-offset">—</span>
        </div>
        <div class="mv-exec-controls">
          <button class="mv-exec-btn mv-thread-code-pause"
                  title=${isPaused ? 'Resume the runtime.' : 'Pause the runtime — all threads + animators freeze.'}
                  onClick=${onPauseToggle}
                  onMouseDown=${(e) => e.stopPropagation()}>
            ${isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button class="mv-exec-btn mv-thread-code-step"
                  title="Step one bytecode instruction.  Sleep/wait clears immediately so you see the next op."
                  onClick=${onStep}
                  onMouseDown=${(e) => e.stopPropagation()}>
            ⤳ Step
          </button>
        </div>
      <//>
      <${CollapsibleSection} title="Locals" panelId=${panelId} sectionKey="locals" defaultCollapsed=${false} bodyClass="mv-collapsible-body">
        <div class="mv-thread-code-locals"></div>
      <//>
      <${CollapsibleSection} title="Globals" panelId=${panelId} sectionKey="globals" defaultCollapsed=${true} bodyClass="mv-collapsible-body">
        <div class="mv-thread-code-globals"></div>
      <//>
      <${CollapsibleSection} title="Stack" panelId=${panelId} sectionKey="stack" defaultCollapsed=${true} bodyClass="mv-collapsible-body">
        <div class="mv-thread-code-stack"></div>
      <//>
    </div>
  `

  // Panel id encodes the thread so the panel-store keys per panel
  // (position / size / sidebar / sections all isolated by thread id).
  // Close hides the panel (panel-store visible=false); modal.js
  // notices the signal flip on its next inspection or via the
  // refresh tick and unmounts.
  return html`
    <${FloatingPanel}
      id=${panelId}
      title=${`Thread #${thread.id} · ${thread.script.name}`}
      rootClass="mv-thread-code-panel"
      bodyClass="mv-thread-code-body"
      headerExtras=${headerExtras}
      sidebar=${sidebar}
      sidebarClass="mv-panel-sidebar"
      resizable=${true}
      minimizable=${true}
      defaultPos=${defaultPos}
      defaultSize=${{ width: 900, height: 560 }}
      minSize=${{ width: 540, height: 280 }}
      onClose=${() => { setPanelVisible(panelId, false) }}>
      <div class="mv-thread-code-source"></div>
      <svg class="mv-thread-code-brackets" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="mv-thread-code-decompiled"></div>
    <//>
  `
}

// Re-export the visibility signal so the host (openMvThreadCodeModal)
// can subscribe to "user clicked the X" and unmount the React tree.
export function panelVisibleSignal(panelId) {
  return panelSignals(panelId).visible
}
