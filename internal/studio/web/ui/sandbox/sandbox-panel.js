// sandbox-panel.js
//
// Preact component for the sandbox-mode floating "Sandbox" panel —
// proof-of-concept for the React migration started in round 14.
// Renders just the Spawn Unit button (everything else moved to the
// ribbon in earlier rounds), wrapped in the shared FloatingPanel
// chrome so drag / collapse / clamp behave identically to the
// legacy panels without per-panel JS.
//
// The host is expected to provide an `onSpawn(sourceEl)` callback
// that opens the side picker anchored to the clicked button.  We
// don't import openSandboxSpawnPicker directly so the React island
// stays uncoupled from studio.js's vast namespace.

import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel } from '@kbot/ui/floating-panel'

export function SandboxPanel({ onSpawn }) {
  const handleSpawnClick = (e) => {
    if (typeof onSpawn === 'function') onSpawn(e.currentTarget)
  }
  return html`
    <${FloatingPanel} id="sandbox-panel" title="Sandbox">
      <div class="mv-controls-actions" style="grid-template-columns: 1fr;">
        <button class="mv-ctrl-action" id="sandbox-spawn" onClick=${handleSpawnClick}>
          <span class="ico">🛠</span><span class="lbl">Spawn Unit</span>
        </button>
      </div>
    <//>
  `
}
