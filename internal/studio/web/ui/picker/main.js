// Entry point for the workspace picker page (served at "/" by the hub).
// A lightweight Preact app — independent of the editor SPA — that lists
// contexts and workspaces and opens each in its own tab.
import { render } from 'preact'
import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { PickerApp } from './picker-app.js'

render(html`<${PickerApp} />`, document.getElementById('picker-app'))
