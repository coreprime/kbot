// spawn-picker.js
//
// Sandbox "Spawn Unit" gesture.  Two helpers:
//
//   - ensureSandboxPanel — first-time mount of the React-rendered
//     Sandbox panel (the floating Spawn-button widget on the canvas).
//     Idempotent: re-entering sandbox mode re-renders into the same
//     mount root rather than stacking panels.
//   - showSandboxPanel — visibility toggle (routed through the
//     panel-store so the React tree re-renders and the persisted
//     visibility flag stays in sync).
//   - openSandboxSpawnPicker — small side-colour popout anchored
//     below the Spawn button.  When the user picks a side, the
//     existing Open Unit dialog opens with the picked side stashed
//     on window.__sandboxSpawnPendingSide; the confirm handler
//     passes that side into sandboxView.beginPlacement so the unit
//     spawns with the right team-colour recolour.
//
// All three were the last sandbox-side helpers in studio.js — pulling
// them here finishes the leaf-helper layer of the R44 sandbox
// extraction.  The bigger surface (activateSandboxTab, the ribbon /
// controls intercept wiring) lives in studio.js still and moves in
// later rounds.

import { hostCallbacks, getReactUi } from '../host-context.js'
import { setMvInspectorVisible } from '../common/inspectors.js'

// 8 team-colour swatches.  Same palette as TEAM_SIDES in
// game3d/team-colors.js — inlined here so this module doesn't have
// to import the engine module at popup-render time.
const SIDES = [
  { side: 0, key: 'blue',   css: '#3a6cd6', label: 'Blue (ARM)' },
  { side: 1, key: 'red',    css: '#eb2e29', label: 'Red (CORE)' },
  { side: 2, key: 'green',  css: '#34c747', label: 'Green' },
  { side: 3, key: 'yellow', css: '#f3d933', label: 'Yellow' },
  { side: 4, key: 'purple', css: '#9e4dd9', label: 'Purple' },
  { side: 5, key: 'cyan',   css: '#34ccea', label: 'Cyan' },
  { side: 6, key: 'orange', css: '#fa8d2e', label: 'Orange' },
  { side: 7, key: 'black',  css: '#1a1a1f', label: 'Black' },
]

// ensureSandboxPanel — bring up the React-rendered sandbox panel the
// first time the user enters sandbox mode.  The Preact island owns
// the DOM (drag / collapse / close / clamp); we just hand it the
// Spawn callback that opens the side picker anchored at the clicked
// button.  Calls configureReactUi (via the hostCallback) to boot
// the UI bridge if it hasn't loaded yet.
export async function ensureSandboxPanel() {
  let ui = getReactUi()
  if (!ui && hostCallbacks.configureReactUi) {
    ui = await hostCallbacks.configureReactUi()
  }
  if (!ui) return
  ui.mountSandboxPanel({
    onSpawn: (sourceEl) => openSandboxSpawnPicker(sourceEl),
  })
}

// showSandboxPanel — flip the React panel-store's visibility signal
// for the Sandbox panel.  Falls back to a plain DOM toggle when the
// UI bridge hasn't loaded yet (very early boot before configureReactUi
// resolved).
export function showSandboxPanel(show) {
  const ui = getReactUi()
  if (ui && typeof ui.showSandboxPanel === 'function') {
    ui.showSandboxPanel(!!show)
    return
  }
  const p = document.getElementById('sandbox-panel')
  if (p) p.classList.toggle('hidden', !show)
}

// setSandboxPanelVisible — uniform visibility toggle that handles
// both the standard mv-inspector panels (which route through
// setMvInspectorVisible so the unit-editor View menu stays in sync)
// AND the bespoke #sandbox-panel (Spawn floating panel) which lives
// outside the MV_INSPECTOR_IDS list.  The panel-store's saveVisible
// callback fires from setMvInspectorVisible so we don't need to
// mirror the dropdown rows here — the React Developer Tools
// dropdown subscribes to the panel-store's visible signal directly
// and re-renders its check on the next tick.
export function setSandboxPanelVisible(panelId, visible) {
  if (panelId === 'sandbox-panel') {
    // Route through showSandboxPanel — when the React UI island has
    // loaded this updates the panel-store's visible signal so the
    // Preact tree re-renders with the right .hidden class.  Before
    // the island is up it falls back to a direct DOM toggle so the
    // toggle still feels responsive on cold starts.
    showSandboxPanel(visible)
    return
  }
  const panel = document.getElementById(panelId)
  if (!panel) return
  setMvInspectorVisible(panelId, visible)
}

// openSandboxSpawnPicker — opens a small side-colour popout
// anchored against the source element the user pressed.  Lazy-creates
// the popout on first call; subsequent calls just re-position + show
// it.  Click-outside dismisses without choosing.
//
// `sourceEl` (optional) is the button the user clicked — the popout
// anchors directly below it.  Callers pass their own button (ribbon
// Spawn, floating-panel Spawn) so the popout always lands adjacent
// to the gesture.  Falls back to the ribbon button if nothing's
// supplied (keeps existing keyboard-driven callers working).
export function openSandboxSpawnPicker(sourceEl = null) {
  let popout = document.getElementById('sandbox-side-popout')
  if (!popout) {
    popout = document.createElement('div')
    popout.id = 'sandbox-side-popout'
    popout.style.cssText = [
      'position: absolute',
      'z-index: 10000',
      'background: rgba(20, 24, 32, 0.96)',
      'border: 1px solid rgba(140, 220, 255, 0.40)',
      'border-radius: 8px',
      'padding: 8px',
      'display: flex',
      'gap: 6px',
      'box-shadow: 0 6px 20px rgba(0,0,0,0.45)',
    ].join('; ')
    for (const s of SIDES) {
      const sw = document.createElement('button')
      sw.type = 'button'
      sw.className = 'sandbox-side-swatch'
      sw.dataset.side = String(s.side)
      sw.title = s.label
      sw.style.cssText = [
        'width: 28px', 'height: 28px',
        'border-radius: 4px',
        'border: 2px solid rgba(255,255,255,0.15)',
        'cursor: pointer',
        'padding: 0',
        `background: ${s.css}`,
      ].join('; ')
      sw.addEventListener('click', () => {
        window.__sandboxSpawnPendingSide = s.side
        window.__sandboxSpawnPending = true
        popout.style.display = 'none'
        hostCallbacks.openModelPicker?.()
      })
      popout.appendChild(sw)
    }
    document.body.appendChild(popout)
    // Click-outside dismiss — bound on document with capture so it
    // fires before the swatch's own click handler when the user
    // releases on a swatch (the swatch's click runs first because
    // it's inside the popout subtree, and then capture re-fires
    // here; we only hide when the target is outside the popout).
    document.addEventListener('mousedown', (e) => {
      if (popout.style.display === 'none') return
      if (popout.contains(e.target)) return
      // Don't dismiss when re-clicking the spawn-triggering buttons —
      // the same gesture would toggle off then on if we did.  The
      // ribbon's outer Sandbox button is the typical anchor (rounds
      // 13+); the inline Spawn Unit menu row + the floating panel's
      // Spawn button cover the legacy callers.
      const sandboxRbBtn = document.getElementById('sandbox-rb-sandbox-btn')
      const spawnRow = document.getElementById('sandbox-rb-spawn')
      const sandboxPanelBtn = document.getElementById('sandbox-spawn')
      if (sandboxRbBtn && sandboxRbBtn.contains(e.target)) return
      if (spawnRow && spawnRow.contains(e.target)) return
      if (sandboxPanelBtn && sandboxPanelBtn.contains(e.target)) return
      popout.style.display = 'none'
    }, true)
  }
  // Anchor under the source element the caller passed (the button
  // the user actually pressed); fall back to the ribbon's Sandbox
  // dropdown button when no source is supplied, then the legacy
  // ribbon Spawn row and finally the floating-panel Spawn button.
  // Pixel-position the popout right below the anchor with a small gap.
  const anchor = sourceEl
    || document.getElementById('sandbox-rb-sandbox-btn')
    || document.getElementById('sandbox-rb-spawn')
    || document.getElementById('sandbox-spawn')
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    popout.style.left = `${Math.round(r.left)}px`
    popout.style.top  = `${Math.round(r.bottom + 6)}px`
  }
  popout.style.display = 'flex'
}
