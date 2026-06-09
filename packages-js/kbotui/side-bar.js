// side-bar.js
//
// The editor sidebar shell: a vertical `<aside class="sidebar">` with a
// header (the SideBarTabStrip) above a body region.  Every editor that
// needs a left rail — the map editor, the unit editor, future tools —
// composes this one component, so the look, the markup, and (when it
// lands) the collapse behaviour all live in a single place.
//
// Usage:
//
//   import { SideBar } from './side-bar.js'
//
//   <${SideBar}
//     tabs=${[{ key: 'sections', label: 'Sections' }, ...]}
//     active=${drawer}
//     onSelect=${(key) => switchDrawer(key)}>
//     <div class="filter">…</div>
//     <div class="drawer">…</div>
//   <//>
//
// Props:
//   tabs / active / onSelect — drive the built-in SideBarTabStrip header.
//   header                   — custom header vnode, overrides tabs.
//   collapsed                — when true, adds `.collapsed` to the aside.
//                              The collapse styling itself is a future
//                              refactor; this is the shared seam so it
//                              only has to be written once.
//   className                — extra classes on the aside.
//   children                 — the body region (filter rows, drawers …).
//
// Bodies that a host paints into imperatively (e.g. the map editor's
// section drawer, repainted by renderDrawer outside the Preact tree)
// must be wrapped in <${FrozenSlot}> so Preact mounts them once and
// never reconciles their contents away on a later re-render.

import { Component } from 'preact'
import { htm as html } from './htm-bind.js'
import { SideBarTabStrip } from './side-bar-tab-strip.js'

// FrozenSlot renders its children exactly once and then opts out of all
// further reconciliation.  Host code can paint into the resulting DOM
// imperatively without Preact clobbering it when the surrounding
// component re-renders (tab switch, filter keystroke, etc.).
export class FrozenSlot extends Component {
  shouldComponentUpdate() { return false }
  render() { return this.props.children }
}

export function SideBar({
  tabs,
  active,
  onSelect,
  header,
  collapsed = false,
  className,
  children,
}) {
  const cls = ['sidebar', collapsed ? 'collapsed' : '', className]
    .filter(Boolean)
    .join(' ')
  const head = header != null
    ? header
    : (tabs
        ? html`<${SideBarTabStrip} tabs=${tabs} active=${active} onSelect=${onSelect} />`
        : null)
  return html`
    <aside class=${cls}>
      ${head}
      ${children}
    </aside>
  `
}
