import { html } from '../index.js'
import { useState } from 'preact/hooks'
import { SideBar } from '../side-bar.js'

export default {
  title: 'Chrome/SideBar',
  parameters: { layout: 'fullscreen' },
}

const TABS = [
  { key: 'sections', label: 'Sections' },
  { key: 'features', label: 'Features' },
]

// The full sidebar shell: tab strip header + a filter row + a scrolling
// body.  Switching tabs swaps the body content, exactly as the map
// editor's left rail does.
function SideBarDemo() {
  const [active, setActive] = useState('sections')
  return html`
    <div style="display:flex;height:460px">
      <${SideBar} tabs=${TABS} active=${active} onSelect=${setActive}>
        <div class="filter">
          <input type="search" placeholder="Filter by name, world, group" />
        </div>
        <div class="drawer" style="padding:10px;color:var(--muted)">
          ${active === 'sections'
            ? 'Section tiles would render here.'
            : 'Map features would render here.'}
        </div>
      <//>
      <div style="flex:1;padding:20px;color:var(--muted)">Canvas area</div>
    </div>
  `
}

export const Full = {
  render: () => html`<${SideBarDemo} />`,
}

// The collapse seam: passing `collapsed` adds `.collapsed` to the aside.
// The collapse styling itself is a future refactor — this story just
// shows the prop is wired through to the shared shell.
export const Collapsed = {
  render: () => html`
    <div style="display:flex;height:320px">
      <${SideBar} tabs=${TABS} active="sections" onSelect=${() => {}} collapsed=${true}>
        <div class="drawer" style="padding:10px;color:var(--muted)">Body (collapsed seam)</div>
      <//>
      <div style="flex:1;padding:20px;color:var(--muted)">Canvas area</div>
    </div>
  `,
}
