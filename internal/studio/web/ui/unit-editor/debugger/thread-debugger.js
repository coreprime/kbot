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
// What this component owns:
//   - FloatingPanel chrome (rootClass=mv-thread-code-panel, custom
//     headerClass=mv-thread-code-header) so the existing studio.css
//     selectors keep applying as-is.
//   - The header search input — typing filters matches in both panes
//     (delegates to applyMvThreadCodeSearch from modal.js).
//   - Pause / Step / Close header actions.
//   - The right-rail sidebar with four CollapsibleSection blocks
//     (Execution / Locals / Globals / Stack) — each section's
//     persisted collapse state is keyed by the panel id.
//   - The empty body containers (source/decompiled/brackets) the
//     existing renderers populate on mount + on every 4 Hz tick.
//
// Lifecycle:
//   - useEffect on (cob, thread.id): build the legacy `state` blob
//     and run the four initial renders synchronously so the user
//     sees both panes populated immediately.
//   - useEffect unmount: abort the AbortController + drop the
//     _mvThreadCodePanels Map entry so refresh-tick.js stops
//     iterating it.
//   - state.panel is set to the FloatingPanel's root <aside>; every
//     renderer's `state.panel.querySelector(...)` lookup resolves
//     against this React-managed root, no DOM cloning needed.

import { useEffect, useRef } from 'preact/hooks'
import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel, CollapsibleSection } from '/ui/common/floating-panel.js'
import { panelSignals, setPanelVisible } from '/ui/common/panel-store.js'
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

  // Pause / Step button handlers.  Mirror the legacy wireMvThreadCodeChrome
  // versions verbatim — separation of concerns: this component owns
  // the chrome wiring, the runtime owns the semantics.
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
  }, [cob, thread.id, thread])

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
  const defaultPos = { top: 120 + cascadeOffset, left: 360 + cascadeOffset }

  // Header extras — title plus the always-visible search input.
  const headerExtras = html`
    <input class="mv-thread-code-search" type="search"
           placeholder="Search…"
           value=${searchSig.value}
           onInput=${onSearchInput}
           onKeyDown=${onSearchKey}
           onClick=${(e) => e.stopPropagation()}
           onMouseDown=${(e) => e.stopPropagation()} />
  `

  // Header actions — Pause / Step buttons.  Caption mirrors the
  // legacy implementation so muscle memory carries over.  Live
  // `cob.runtime.paused` reads aren't reactive here — the refresh
  // tick re-runs refreshMvThreadCodeHighlight which writes the
  // caption directly on the DOM button.  We initialise to current.
  const isPaused = !!cob?.runtime?.paused
  const headerActions = html`
    <button class="minimap-toggle mv-thread-code-pause"
            title=${isPaused ? 'Resume the runtime.' : 'Pause or resume the entire COB runtime.'}
            onClick=${onPauseToggle}
            onMouseDown=${(e) => e.stopPropagation()}>
      ${isPaused ? '▶ Resume' : '⏸ Pause'}
    </button>
    <button class="minimap-toggle mv-thread-code-step"
            title="Single-step the bytecode — advance exactly one instruction."
            onClick=${onStep}
            onMouseDown=${(e) => e.stopPropagation()}>
      ⤳ Step
    </button>
  `

  // Sidebar tray — Execution / Locals / Globals / Stack as
  // collapsible sections, persisted per-panel-id.  The empty
  // containers inside each section are populated by
  // refreshMvThreadCodeHighlight + renderMvThreadCodeLocals.
  const sidebar = html`
    <div class="mv-thread-code-locals-panel">
      <${CollapsibleSection} title="Execution" panelId=${panelId} sectionKey="exec" defaultCollapsed=${false}>
        <div class="mv-exec-row"><span>Status</span><span class="mv-exec-status">—</span></div>
        <div class="mv-exec-row"><span>PC</span><span class="mv-exec-pc">—</span></div>
        <div class="mv-exec-row"><span>Offset</span><span class="mv-exec-offset">—</span></div>
      <//>
      <${CollapsibleSection} title="Locals" panelId=${panelId} sectionKey="locals" defaultCollapsed=${false}>
        <div class="mv-thread-code-locals"></div>
      <//>
      <${CollapsibleSection} title="Globals" panelId=${panelId} sectionKey="globals" defaultCollapsed=${true}>
        <div class="mv-thread-code-globals"></div>
      <//>
      <${CollapsibleSection} title="Stack" panelId=${panelId} sectionKey="stack" defaultCollapsed=${true}>
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
      headerClass="mv-thread-code-header"
      bodyClass="mv-thread-code-body"
      headerExtras=${headerExtras}
      headerActions=${headerActions}
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
