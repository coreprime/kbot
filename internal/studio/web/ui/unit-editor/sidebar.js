// sidebar.js
//
// Unit-editor left-panel sidebar — Pieces / Textures / Weapons tabs.
// The actual tab BODIES are React-managed already (the components live
// in /ui/unit-editor/tabs/piece-tree.js, textures-tab.js, weapons-tab.js);
// this module owns the thin host-side bridge that hands the freshly
// loaded model + COB to those components, wires the legacy tab-bar
// click handler that swaps the visible panel, runs the Weapons-tab
// audio-preview + change-weapon picker, and exposes piece-tree helpers
// (selectPiece / filterPieceTree) the host's keyboard + filter input
// still drive.
//
// What lives here:
//
//   - renderPieceTree(model) — pushes model to React PieceTree
//   - renderTexturesTab(model) — pushes model to React TexturesTab
//   - renderMvWeaponsTab(mv) — bumps runtimeTick so WeaponsTab repaints
//   - refreshMvWeaponsLive() — same hook, kept for call-site compat
//   - refreshPieceTreeEyes() — no-op (React subscribes via runtimeTick)
//   - wireMvSidebarTabs() — Pieces/Textures tab-bar click handler
//   - selectPiece(name) — jump camera + highlight tree row
//   - filterPieceTree(q) — name-filter on the tree DOM
//   - playWeaponSound(stem) — audio preview routed through the
//     active viewer's cob.audio pool
//   - openWeaponPicker(mv, slotIndex) — change-weapon dialog flow
//   - loadWeaponCatalogue() — one-shot fetch of /api/studio/weapons
//
// Cross-module deps come through host-context (state-free utility
// imports + hostCallbacks for accessors that still belong to
// studio.js, like the active modelViewerInstance + MvControls
// instance + configureReactUi).

import { $, $$, hostCallbacks, getReactUi } from '../host-context.js'

// _weaponCatalogue — catalogue cache for the Change-Weapon dialog.
// Fetched lazily on first open and reused thereafter — the VFS doesn't
// change after startup so a single fetch covers the whole session.
let _weaponCatalogue = null

// refreshPieceTreeEyes — no-op now that the piece tree is React-managed.
// The React PieceTree subscribes to runtimeTick + inspector-store.mv
// directly, so the per-frame icon refresh happens via signal commit.
// Kept as an exported function so the studio's per-tick refresh tail
// has a stable call site (a future round can drop the call too).
export function refreshPieceTreeEyes() { /* React subscribes to runtimeTick */ }

// renderPieceTree replaces the sidebar drawer with a hierarchical
// piece view.  React-managed (see /ui/unit-editor/tabs/piece-tree.js).
// The host hands the model to the React component via setPieceTreeModel;
// the tree subscribes to runtimeTick + inspector-store.mv so the
// eye/shade/cache/shadow icons, hover-highlight, and selectPiece
// routing all flow through React.
export function renderPieceTree(model) {
  const ui = getReactUi()
  if (ui && typeof ui.setPieceTreeModel === 'function') {
    ui.setPieceTreeModel(model)
  }
}

// wireMvSidebarTabs wires the Pieces / Textures tab buttons once.
// Idempotent — sets data-wired so subsequent model loads don't
// stack handlers.  Tab click swaps which .mv-sidebar-panel is
// visible AND nulls any active texture-hover state (a Textures
// → Pieces switch must clear the red highlight or it sticks).
export function wireMvSidebarTabs() {
  const bar = document.querySelector('.mv-sidebar-tabs')
  if (!bar || bar.dataset.wired === '1') return
  bar.dataset.wired = '1'
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mv-tab]')
    if (!btn) return
    const tab = btn.dataset.mvTab
    for (const t of bar.querySelectorAll('[data-mv-tab]')) {
      const on = t.dataset.mvTab === tab
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    for (const p of document.querySelectorAll('.mv-sidebar-panel')) {
      p.classList.toggle('hidden', p.dataset.mvTabPanel !== tab)
    }
    // Switching tabs implicitly clears any hover-highlight state
    // (a stuck red wireframe after leaving the textures tab
    // would look broken).
    const mv = hostCallbacks.getActiveModelViewer?.()
    mv?.renderer?.setHoveredTexture?.(null)
    mv?.renderer?.setHoveredPieceName?.(null)
  })
}

// renderTexturesTab builds the Textures left-panel content.
// React-managed (see /ui/unit-editor/tabs/textures-tab.js).
export function renderTexturesTab(model) {
  const ui = getReactUi()
  if (ui && typeof ui.setTexturesModel === 'function') {
    ui.setTexturesModel(model)
  }
}

// renderMvWeaponsTab — the React Weapons tab subscribes to the
// inspector-store mv signal directly, so the host doesn't push
// data explicitly.  Bumping runtimeTick re-renders the tree.
// Kept for call-site compatibility (e.g. weapon swap reflow).
export function renderMvWeaponsTab(_mv) {
  const ui = getReactUi()
  if (ui && typeof ui.bumpRuntimeTick === 'function') {
    ui.bumpRuntimeTick()
  }
}

// refreshMvWeaponsLive — call-site stub; the React Weapons tab
// subscribes to runtimeTick directly so no explicit re-render
// needed here.
export function refreshMvWeaponsLive() {
  /* React subscribes to runtimeTick */
}

// playWeaponSound previews a weapon sound effect from the unit's
// AudioPool.  Position from the controls overlay (authoritative live
// unit pos) when available so the listener-relative attenuation is
// realistic; otherwise origin.
export function playWeaponSound(stem) {
  if (!stem) return
  const mv = hostCallbacks.getActiveModelViewer?.()
  const pool = mv && mv.cob && mv.cob.audio
  if (!pool) return
  const ctrl = mv && mv._mvControls
  const pos = ctrl ? [ctrl.pos.x, ctrl.alt || 0, ctrl.pos.z] : null
  pool.play(stem, { vol: 0.6, kind: 'ui', source: `Preview: ${stem}`, pos })
}

// openWeaponPicker shows the Change Weapon dialog scoped to one slot
// of one unit.  React-managed (see /ui/pickers/weapon-picker-dialog.js);
// we resolve the slot's current weapon name + the catalogue, then hand
// them to the React opener.  On Apply we re-call /api/studio/unit/{name}
// with the override query param and re-render the Weapons panel.
export async function openWeaponPicker(mv, slotIndex) {
  if (!mv) return
  const name = mv.cob && mv.cob.unit && mv.cob.unit.name
  if (!name) return
  const ui = getReactUi() || await hostCallbacks.configureReactUi?.()
  if (!ui || typeof ui.openWeaponPicker !== 'function') return
  // Current weapon name for this slot — surfaces as "(current)" + the
  // .active row highlight in the picker so the user sees what's
  // already installed before swapping.
  const currentMeta = mv.unitMeta && mv.unitMeta.weapons
  const currentName = currentMeta && currentMeta[slotIndex - 1]
    ? currentMeta[slotIndex - 1].name
    : ''
  // Slot label for the dialog title.  Picker is one dialog reused
  // across all three slots so the title carries the slot context.
  const slotLabel = slotIndex === 1 ? 'Primary'
    : slotIndex === 2 ? 'Secondary'
    : slotIndex === 3 ? 'Tertiary'
    : `Slot ${slotIndex}`
  // Open with a loading hint first; push the catalogue in once it
  // arrives.  In practice the catalogue is cached after the first
  // open so this path resolves immediately on repeat opens.
  const inFlight = ui.openWeaponPicker({
    items: _weaponCatalogue || [],
    loading: !_weaponCatalogue,
    query: '',
    currentName,
    slotLabel,
    paletteColor: (idx) => {
      const activeMv = hostCallbacks.getActiveModelViewer?.()
      const pal = activeMv && activeMv.palette
      if (!pal || idx <= 0) return null
      return pal.colorFor(idx)
    },
  })
  if (!_weaponCatalogue) {
    loadWeaponCatalogue().then((list) => {
      if (typeof ui.updateWeaponPicker === 'function') {
        ui.updateWeaponPicker({ items: list, loading: false })
      }
    })
  }
  const picked = await inFlight
  if (!picked) return
  // Build the override URL + remember the swap on the viewer so a
  // re-fetch doesn't lose it.
  const params = new URLSearchParams()
  params.set(`weapon${slotIndex}`, picked)
  const mv2 = hostCallbacks.getActiveModelViewer?.()
  if (!mv2) return
  mv2._weaponOverrides = mv2._weaponOverrides || {}
  mv2._weaponOverrides[slotIndex] = picked
  for (const [k, v] of Object.entries(mv2._weaponOverrides)) {
    if (parseInt(k, 10) !== slotIndex) params.set(`weapon${k}`, v)
  }
  try {
    const resp = await fetch(`/api/studio/unit/${encodeURIComponent(name)}?${params.toString()}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    mv2.unitMeta = await resp.json()
    renderMvWeaponsTab(mv2)
    // Notify the active MvControls that meta changed — it rebuilds
    // its slot bindings so a freshly-swapped weapon's Aim/Fire path
    // picks up immediately.
    const ctrls = hostCallbacks.getActiveMvControls?.()
    if (ctrls && typeof ctrls.onMetaLoaded === 'function') ctrls.onMetaLoaded()
  } catch (err) {
    console.warn('[weapon-swap] failed:', err)
  }
}

// loadWeaponCatalogue fetches /api/studio/weapons once per session and
// caches the result.  Returns a Promise<Array<WeaponCatalogueEntry>>.
// On failure caches an empty array so subsequent opens just get an
// empty picker (rather than spamming the API with retries).
export function loadWeaponCatalogue() {
  if (_weaponCatalogue) return Promise.resolve(_weaponCatalogue)
  return fetch('/api/studio/weapons').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }).then((list) => {
    _weaponCatalogue = Array.isArray(list) ? list : []
    return _weaponCatalogue
  }).catch((err) => {
    console.warn('[weapon-catalogue] fetch failed:', err)
    _weaponCatalogue = []
    return _weaponCatalogue
  })
}

// selectPiece jumps the camera to focus on the named piece + highlights
// the matching row in the React tree's selected state (the React tree
// subscribes to the same selector update via inspector-store).  Also
// flips legacy `.selected` classes on tree rows for any CSS rules
// still keyed off them.
export function selectPiece(name) {
  const mv = hostCallbacks.getActiveModelViewer?.()
  if (!mv) return
  mv.jumpToPiece(name)
  $$('#model-viewer-tree .drawer-item-piece, #model-viewer-tree .drawer-piece-group').forEach((el) => {
    el.classList.toggle('selected', el.dataset.piece === name)
  })
}

// filterPieceTree hides rows whose piece name (lowercase) doesn't
// contain `q`.  Groups stay visible whenever any descendant matches —
// so typing "nano" still surfaces the parent assembly.
export function filterPieceTree(q) {
  q = (q || '').trim().toLowerCase()
  const host = $('#model-viewer-tree')
  if (!host) return
  const matches = (el) => {
    const name = (el.dataset.piece || '').toLowerCase()
    if (!q) return true
    if (name.includes(q)) return true
    // For groups, recurse into children — if any matches, keep us
    // visible so the user sees the path through the hierarchy.
    return Array.from(el.querySelectorAll('[data-piece]')).some((c) => c.dataset.piece.toLowerCase().includes(q))
  }
  host.querySelectorAll('[data-piece]').forEach((el) => {
    el.style.display = matches(el) ? '' : 'none'
  })
}
