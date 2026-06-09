import { html } from '../index.js'
import { useState } from 'preact/hooks'
import { SideBarTabStrip } from '../side-bar-tab-strip.js'

export default {
  title: 'Chrome/SideBarTabStrip',
  parameters: { layout: 'padded' },
}

const TABS = [
  { key: 'sections', label: 'Sections' },
  { key: 'features', label: 'Features' },
]

// The strip that heads an editor sidebar — clicking a tab switches the
// active drawer.  Matches the map editor's Sections / Features switch.
function InteractiveSidebarTabs() {
  const [active, setActive] = useState('sections')
  return html`
    <div style="width:280px">
      <${SideBarTabStrip} tabs=${TABS} active=${active} onSelect=${setActive} />
      <div style="padding:14px 6px;color:var(--muted)">
        Active drawer: <strong style="color:var(--text)">${active}</strong>
      </div>
    </div>
  `
}

export const Interactive = {
  render: () => html`<${InteractiveSidebarTabs} />`,
}
