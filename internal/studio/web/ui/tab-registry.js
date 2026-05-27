// tab-registry.js
//
// Central registrar for the studio's tab types.  Each section (map
// editor, unit editor, sandbox, and any future ones) registers a
// descriptor at boot through `registerTabType`; studio.js's tab
// dispatch consults the registry instead of branching on tab type
// internally.
//
// Goals
// -----
//   - No `if (tab.type === 'map') ... else if (tab.type === 'model')`
//     branches anywhere in the host.  Type-specific behaviour lives
//     in the descriptor.
//   - Each tab type owns its FULL state.  No `tab.viewer` /
//     `tab.map` fields the host reads — those are private to the
//     instance the descriptor returned.
//   - Lifecycle is uniform: activate / deactivate / canClose /
//     dispose.  Optional snapshot / restore for tabs that need
//     module-let state preserved across focus changes.
//   - The registry is data-only: it has no DOM, no React, no host
//     state.  Boot-side wiring lives in each section's
//     register-tab.js.
//
// Descriptor shape
// ----------------
//   {
//     typeId,                  unique string id (e.g. 'unit-editor')
//     label,                   default tab-strip label
//     glyph,                   tab-strip glyph (emoji or short string)
//     create(spec) → instance, factory; spec is whatever the opener
//                              passed via openTab(typeId, spec)
//   }
//
// Instance shape
// --------------
//   {
//     // Lifecycle.  ctx = { stage, isFresh, fromTypeId, toTypeId }.
//     async activate(ctx)         focus gained — attach to stage,
//                                 start renderer, unsilence audio,
//                                 resume runtime, etc.  Called for
//                                 EVERY focus gain including the
//                                 first activation (isFresh=true).
//     deactivate(ctx)             focus lost — release stage, stop
//                                 renderer, silence audio, pause
//                                 runtime.  Called on EVERY focus
//                                 loss (tab swap, tab close, app
//                                 minimise) so the framework can
//                                 guarantee only the active tab
//                                 holds the canvas / audio context.
//     async canClose?(ctx)        optional; returns boolean.  Used
//                                 by the host's close path to honour
//                                 dirty-confirmation prompts.
//                                 Default true.
//     dispose(ctx)                final teardown.  Free GPU buffers,
//                                 dispose audio pools, kill RAF
//                                 loops.  Called once per instance.
//
//     // Metadata.
//     displayName()               tab-strip / topbar label
//     dirty?()                    optional; drives the × indicator
//                                 and canClose prompt
//
//     // Optional state preservation across focus changes.  Used by
//     // tabs that rely on host-side module-let state (e.g. map
//     // editor's per-map proxy).  Most types won't implement these.
//     snapshot?()                 stash module-let state into spec
//     restore?()                  pull module-let state from spec
//   }

import { tabs, tabState, $ } from './host-context.js'
import { destroyEditorView } from './map-editor/editor-view.js'
import { abortTransientGestureState } from './map-editor/boot.js'
import { closeAllMvThreadCodePanels } from './unit-editor/debugger/modal.js'
import { renderMapTabs } from './tab-bar.js'

// Registered descriptors, keyed by typeId.  Populated by each
// section's register-tab.js at boot.  Mutating after boot is allowed
// but undefined for already-open tabs.
const _types = new Map()

// registerTabType — install a descriptor.  Throws if typeId is
// already registered so a duplicate import wires up only once.
export function registerTabType(descriptor) {
  if (!descriptor || !descriptor.typeId) {
    throw new Error('[tab-registry] descriptor.typeId is required')
  }
  if (typeof descriptor.create !== 'function') {
    throw new Error(`[tab-registry] descriptor.${descriptor.typeId}.create must be a function`)
  }
  if (_types.has(descriptor.typeId)) {
    throw new Error(`[tab-registry] tab type already registered: ${descriptor.typeId}`)
  }
  _types.set(descriptor.typeId, descriptor)
}

// getTabType — look up a descriptor.  Returns undefined when the
// typeId is unknown so callers can defensively bail.
export function getTabType(typeId) {
  return _types.get(typeId)
}

// listTabTypes — every registered descriptor, in registration order.
// Used by UI surfaces that enumerate "what kinds of tab can I
// open?" (e.g. the tab-strip's `+` menu).
export function listTabTypes() {
  return [...new Set(_types.values())]
}

// createTab — instantiate a tab through its descriptor.  Returns
// `{ typeId, spec, instance }` — the host's tabs[] array stores this
// shape and never peeks inside `instance`.
export function createTab(typeId, spec = {}) {
  const desc = _types.get(typeId)
  if (!desc) throw new Error(`[tab-registry] unknown tab type: ${typeId}`)
  const instance = desc.create(spec)
  if (!instance) throw new Error(`[tab-registry] ${typeId}.create returned null`)
  return { typeId, spec, instance, descriptor: desc }
}

// openTab — single entry point for adding a tab to the host.  Each
// opener (openLoadedMap, openModelViewer, openSandboxStub,
// startEditor) builds its type-specific spec and routes here.
// The function:
//   1. Builds the registry instance via createTab(typeId, spec).
//   2. Pushes the host record (which carries the descriptor + spec +
//      instance) into tabs[].
//   3. Calls instance.attachTabRef so the descriptor can mirror
//      legacy fields onto the host record for back-compat.
//   4. Switches focus to the new tab (unless opts.defer is true,
//      in which case the caller is responsible for the switch —
//      used by openers that need to populate the spec further
//      before the first activation).
// Returns the freshly-attached host record.
export function openTab(typeId, spec = {}, opts = {}) {
  const record = createTab(typeId, spec)
  tabs.push(record)
  if (typeof record.instance.attachTabRef === 'function') {
    record.instance.attachTabRef(record)
  }
  tabState.activeIndex = tabs.length - 1
  if (!opts.defer) void switchToTab(tabState.activeIndex, { fresh: true, force: true })
  return record
}

// _ensureTabInstance backfills the registry-managed
// `tab.typeId` + `tab.descriptor` + `tab.instance` fields onto tab
// records the legacy openers push with the old shape.  After every
// opener routes through openTab() this shim should be dead — keep
// it defensive in case any external path still pushes legacy
// records into tabs[].
function _ensureTabInstance(tab) {
  if (!tab) return
  if (tab.instance) return
  // Map legacy discriminator -> typeId.  'model' tabs split into
  // 'sandbox' or 'unit-editor' based on the sandbox flag.
  let typeId = tab.typeId
  if (!typeId) {
    if (tab.type === 'model') typeId = tab.sandbox ? 'sandbox' : 'unit-editor'
    else if (tab.type === 'map') typeId = 'map'
  }
  if (!typeId) return
  const desc = getTabType(typeId)
  if (!desc) return
  // Build the descriptor's spec from whatever legacy fields the
  // opener stashed onto the tab record.  This is the only place
  // legacy-field reads survive in the new dispatch — once openers
  // migrate, spec is what they pass to createTab.
  let spec
  if (typeId === 'map') {
    spec = { map: tab.map }
  } else if (typeId === 'unit-editor') {
    spec = { name: tab.name, meta: tab.meta, displayName: tab.displayName }
  } else if (typeId === 'sandbox') {
    spec = { displayName: tab.displayName || tab.name || 'Sandbox' }
  } else {
    spec = {}
  }
  const instance = desc.create(spec)
  if (typeof instance.attachTabRef === 'function') instance.attachTabRef(tab)
  tab.typeId = typeId
  tab.descriptor = desc
  tab.instance = instance
}

// closeTab routes through the tab registry.  Each tab type's
// instance owns its canClose (dirty prompt) and dispose semantics —
// the host's only responsibilities are bringing focus to the
// closing tab BEFORE the prompt (so the user sees what they're
// about to discard), and re-activating the next tab in line once
// the splice is done.
export async function closeTab(idx) {
  if (idx < 0 || idx >= tabs.length) return
  const tab = tabs[idx]
  _ensureTabInstance(tab)
  // Bring focus to the closing tab first so the dirty-confirm modal
  // shows the right canvas behind it AND the save() inside
  // canClose() operates on the right active state.
  if (idx !== tabState.activeIndex) {
    await switchToTab(idx, { force: true })
  }
  const ok = await tab.instance.canClose({})
  if (!ok) return
  // Deactivate before dispose so the per-tab renderer / runtime
  // releases its hold cleanly before dispose tears down GPU buffers.
  if (idx === tabState.activeIndex) tab.instance.deactivate({})
  tab.instance.dispose({})
  tabs.splice(idx, 1)
  if (tabs.length === 0) {
    tabState.activeIndex = -1
    $('#model-viewer-dialog')?.classList.add('hidden')
    showWelcomeAfterLastTabClose()
    return
  }
  // Pick the previous tab if we closed the active one; otherwise
  // stay on the same active tab (its index shifts left when the
  // closed one was to its left).
  if (idx < tabState.activeIndex) tabState.activeIndex -= 1
  if (tabState.activeIndex >= tabs.length) tabState.activeIndex = tabs.length - 1
  if (tabState.activeIndex < 0) tabState.activeIndex = 0
  await switchToTab(tabState.activeIndex, { fresh: false, force: true })
}

export function showWelcomeAfterLastTabClose() {
  // Hide the editor surface and bring back the welcome modal.
  $('#app')?.classList.add('hidden')
  const wel = $('#welcome-dialog')
  if (wel) wel.classList.remove('hidden')
  destroyEditorView()
  renderMapTabs()
}

// switchToTab routes focus through the tab registry.  The dispatcher
// is type-agnostic — every per-type decision (DOM toggles, renderer
// start/stop, audio silence, panel show/hide, module-let snapshot /
// restore) lives in the tab descriptor's activate / deactivate.
//
// Lifecycle guarantee: when this returns, exactly one tab's
// instance.activate has been called and every other tab's
// instance.deactivate is in a quiescent state.  Deactivate is
// idempotent + cheap so the framework can call it across every
// non-active tab on each swap to enforce that invariant.
export async function switchToTab(nextIdx, { fresh = false, force = false } = {}) {
  if (nextIdx < 0 || nextIdx >= tabs.length) return
  if (!force && nextIdx === tabState.activeIndex) return
  const outgoing = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  const incoming = tabs[nextIdx]
  _ensureTabInstance(incoming)

  // Close every open thread-debugger panel — they point at the
  // outgoing tab's COB binding, which is either about to be
  // replaced (switching between models) or hidden behind the map
  // editor (switching to a map tab).  Reopening from the Threads
  // inspector is one click.
  closeAllMvThreadCodePanels()

  const ctx = {
    fromTypeId: outgoing?.typeId || null,
    toTypeId: incoming?.typeId || null,
    isFresh: !!fresh,
  }

  // Deactivate EVERY non-incoming tab so the framework can
  // guarantee only the incoming holds the canvas / audio / RAF
  // loop on the way out.  Deactivate is idempotent.
  for (const t of tabs) {
    if (t === incoming) continue
    _ensureTabInstance(t)
    try { t.instance.deactivate(ctx) } catch { /* ignore */ }
  }

  abortTransientGestureState()
  tabState.activeIndex = nextIdx
  renderMapTabs()

  // Per-descriptor activation does its own DOM + renderer + audio
  // wiring.  Errors here are intentionally allowed to surface so a
  // broken tab doesn't silently fail to mount.
  await incoming.instance.activate(ctx)
}

// pauseOutgoingTabRuntime — replaced by each tab descriptor's
// deactivate() (Phase A).  Studio.js's switchToTab no longer
// branches by type; the framework calls instance.deactivate() on
// every non-incoming tab on every swap, and each instance owns the
// pause / silence / renderer-stop sequence.
