import { html } from '../index.js'
import { AccordionSection } from '../accordion-section.js'

export default {
  title: 'Chrome/AccordionSection',
  parameters: { layout: 'padded' },
}

// A single collapsible section with a count badge.  Click the header to
// toggle; state is local to the component.
export const Single = {
  render: () => html`
    <div style="width:320px">
      <${AccordionSection} id="story-acc-1" title="Pieces" count=${18} defaultOpen=${true}>
        <div style="padding:8px 10px;color:var(--muted)">base, turret, barrel…</div>
      <//>
    </div>
  `,
}

// A stack of sections, the pattern used down the unit-editor sidebar.
export const Stack = {
  render: () => html`
    <div style="width:320px">
      <${AccordionSection} id="story-acc-a" title="Geometry" count=${42} defaultOpen=${true}>
        <div style="padding:8px 10px;color:var(--muted)">vertices, primitives…</div>
      <//>
      <${AccordionSection} id="story-acc-b" title="Textures" count=${6}>
        <div style="padding:8px 10px;color:var(--muted)">team / shared atlases…</div>
      <//>
      <${AccordionSection} id="story-acc-c" title="Weapons" count=${2}>
        <div style="padding:8px 10px;color:var(--muted)">primary, secondary…</div>
      <//>
    </div>
  `,
}
