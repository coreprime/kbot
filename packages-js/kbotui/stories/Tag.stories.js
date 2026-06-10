import { html } from '../index.js'
import { Tag } from '../tag.js'

export default {
  title: 'Primitives/Tag',
  parameters: { layout: 'fullscreen' },
}

export const Tones = {
  render: () => html`
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <${Tag}>totala<//>
      <${Tag}>3.1c<//>
      <${Tag}>parent: ta-base<//>
      <${Tag} tone="accent">current<//>
    </div>
  `,
}
