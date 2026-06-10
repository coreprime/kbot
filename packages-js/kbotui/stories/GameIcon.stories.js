import { html } from '../index.js'
import { GameIcon, GameChip, GAME } from '../game-icon.js'
import { Tag } from '../tag.js'

export default {
  title: 'Primitives/GameIcon',
  parameters: { layout: 'fullscreen' },
}

export const Icons = {
  render: () => html`
    <div style="display:flex;gap:16px;align-items:center">
      ${Object.keys(GAME).map((g) => html`<${GameIcon} key=${g} game=${g} size=${28} />`)}
    </div>
  `,
}

export const Chips = {
  render: () => html`
    <div style="display:grid;gap:10px;justify-items:start">
      <${GameChip} game="totala" />
      <${GameChip} game="takingdoms" />
      <${GameChip} game="custom" />
    </div>
  `,
}

// Game chip alongside the differentiated version chip, as the picker
// shows them on a context row.
export const WithVersionChip = {
  render: () => html`
    <div style="display:flex;gap:8px;align-items:center">
      <${GameChip} game="totala" />
      <${Tag} tone="version">v3.1c<//>
      <${Tag} tone="accent">current<//>
    </div>
  `,
}
