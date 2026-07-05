// Pull in the studio's stylesheet so @coreprime/kbot-ui chrome renders with the
// real design tokens, ribbon/panel/tab styling and dark theme.
import '../../../internal/studio/web/studio.css'
import { html } from '../index.js'

export default {
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'studio',
      values: [
        { name: 'studio', value: '#0f1115' },
        { name: 'panel', value: '#161a21' },
      ],
    },
    controls: { expanded: true },
  },
  decorators: [
    // Frame every story in the studio's base text colour + sans stack and
    // a little breathing room, matching how the chrome sits in-app.
    (Story) => html`
      <div
        style="color:var(--text);font-family:var(--sans);padding:24px;min-height:100vh"
      >
        ${Story()}
      </div>
    `,
  ],
}
