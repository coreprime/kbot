import { html } from '../index.js'
import { useState } from 'preact/hooks'
import { TabStrip } from '../tab-strip.js'

export default {
  title: 'Chrome/TabStrip',
  parameters: { layout: 'padded' },
}

const TABS = [
  { id: 'pieces', label: 'Pieces' },
  { id: 'textures', label: 'Textures' },
  { id: 'weapons', label: 'Weapons' },
]

// An interactive tab strip: clicking a tab updates the active selection.
function InteractiveTabs() {
  const [active, setActive] = useState('pieces')
  return html`
    <div style="width:360px">
      <${TabStrip} tabs=${TABS} active=${active} onSelect=${setActive} />
      <div style="padding:14px 6px;color:var(--muted)">
        Active tab: <strong style="color:var(--text)">${active}</strong>
      </div>
    </div>
  `
}

export const Interactive = {
  render: () => html`<${InteractiveTabs} />`,
}

export const ManyTabs = {
  render: () => {
    const tabs = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      label: `Tab ${i + 1}`,
    }))
    return html`
      <div style="width:520px">
        <${TabStrip} tabs=${tabs} active="t2" onSelect=${() => {}} />
      </div>
    `
  },
}
