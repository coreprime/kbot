import { html } from '../index.js'
import { InterfaceStatusBar } from '../interface-status-bar.js'

export default {
  title: 'Chrome/InterfaceStatusBar',
  parameters: { layout: 'fullscreen' },
}

// The footer strip exactly as the studio shell shows it: a status
// message on the left, hints pushed to the right, and a trailing
// copyright note.
export const Full = {
  render: () => html`
    <${InterfaceStatusBar}
      status="Ready.  Pick a section on the left, then click on the canvas to stamp it."
      hints=${html`Drag-paint with the mouse.  Hold <kbd>Shift</kbd> to erase.  Scroll to zoom.`}
      copyright=${html`KBot © Steve Gray 2026`}
    />
  `,
}

// Just a status message — the minimal form.
export const StatusOnly = {
  render: () => html`<${InterfaceStatusBar} status="Loading filesystem…" />`,
}
