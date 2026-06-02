import { html } from '../index.js'
import {
  Ribbon,
  RibbonSection,
  RibbonButton,
  RibbonDropdownButton,
  MenuRow,
  MenuSectionLabel,
} from '../ribbon.js'

export default {
  title: 'Chrome/Ribbon',
  parameters: { layout: 'fullscreen' },
}

// A single labelled section of buttons.
export const Section = {
  render: () => html`
    <${Ribbon}>
      <${RibbonSection} label="Orders">
        <${RibbonButton} icon="➤" label="Move" active=${true} />
        <${RibbonButton} icon="✶" label="Attack" />
        <${RibbonButton} icon="■" label="Stop" />
      <//>
    <//>
  `,
}

// Several sections side by side, the way the studio lays out its top bar.
export const FullBar = {
  render: () => html`
    <${Ribbon}>
      <${RibbonSection} label="Sandbox">
        <${RibbonDropdownButton} icon="🎮" label="Sandbox" />
      <//>
      <${RibbonSection} label="Orders">
        <${RibbonButton} icon="➤" label="Move" active=${true} />
        <${RibbonButton} icon="✶" label="Attack" />
        <${RibbonButton} icon="■" label="Stop" />
      <//>
      <${RibbonSection} label="Selection">
        <${RibbonButton} icon="☑" label="All" />
        <${RibbonButton} icon="☐" label="None" />
      <//>
      <${RibbonSection} label="View">
        <${RibbonDropdownButton} icon="◎" label="View" />
      <//>
      <${RibbonSection} label="Graphics Options">
        <${RibbonDropdownButton} icon="🎨" label="Graphics" />
      <//>
    <//>
  `,
}

// Disabled + inactive button states for visual reference.
export const ButtonStates = {
  render: () => html`
    <${Ribbon}>
      <${RibbonSection} label="States">
        <${RibbonButton} icon="●" label="Active" active=${true} />
        <${RibbonButton} icon="○" label="Inactive" />
        <${RibbonButton} icon="✕" label="Disabled" disabled=${true} />
      <//>
    <//>
  `,
}

// A standalone dropdown surface, the content a dropdown button reveals.
export const DropdownContent = {
  render: () => html`
    <div
      class="ribbon-dropdown-popup"
      style="position:relative;display:block;width:240px"
    >
      <${MenuSectionLabel}>Camera<//>
      <${MenuRow} label="Reset Camera" onClick=${() => {}} />
      <${MenuRow} label="Frame Selection" onClick=${() => {}} />
      <${MenuSectionLabel}>Layout<//>
      <${MenuRow} label="Split Horizontal" onClick=${() => {}} />
      <${MenuRow} label="Split Vertical" onClick=${() => {}} />
    </div>
  `,
}
