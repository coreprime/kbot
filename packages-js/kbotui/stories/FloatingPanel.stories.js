import { html } from '../index.js'
import { FloatingPanel, CollapsibleSection } from '../floating-panel.js'

export default {
  title: 'Chrome/FloatingPanel',
  parameters: { layout: 'fullscreen' },
}

// A draggable, collapsible panel — the building block for the studio's
// Renderer / Runtime / Controls overlays.  Drag it by the title bar; the
// −/✕ buttons collapse and hide it.
export const Basic = {
  render: () => html`
    <div style="position:relative;height:420px">
      <${FloatingPanel}
        id="story-basic"
        title="Renderer"
        defaultPos=${{ top: 40, left: 40 }}
      >
        <div style="padding:8px 10px;display:grid;gap:6px">
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--muted)">Position</span><span>−89.2, 155.6, −127.4</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--muted)">Yaw</span><span>215.0°</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:var(--muted)">Distance</span><span>220.0 wu</span>
          </div>
        </div>
      <//>
    </div>
  `,
}

// Two panels coexisting, as overlays do in the sandbox.
export const Multiple = {
  render: () => html`
    <div style="position:relative;height:480px">
      <${FloatingPanel} id="story-multi-a" title="Controls" defaultPos=${{ top: 30, left: 30 }}>
        <div style="padding:10px;color:var(--muted)">No units selected.</div>
      <//>
      <${FloatingPanel} id="story-multi-b" title="I/O Ports" defaultPos=${{ top: 120, left: 320 }}>
        <div style="padding:10px;color:var(--muted)">No COB loaded.</div>
      <//>
    </div>
  `,
}

// A panel hosting collapsible sub-sections.
export const WithSections = {
  render: () => html`
    <div style="position:relative;height:460px">
      <${FloatingPanel} id="story-sections" title="Inspector" defaultPos=${{ top: 40, left: 40 }}>
        <${CollapsibleSection} panelId="story-sections" sectionKey="transform" title="Transform">
          <div style="padding:8px 10px;color:var(--muted)">x / y / z fields…</div>
        <//>
        <${CollapsibleSection} panelId="story-sections" sectionKey="material" title="Material" defaultCollapsed=${true}>
          <div style="padding:8px 10px;color:var(--muted)">team colour, shading…</div>
        <//>
      <//>
    </div>
  `,
}
