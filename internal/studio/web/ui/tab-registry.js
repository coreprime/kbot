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
