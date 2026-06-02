import { html } from '../index.js'
import { HexView } from '../hex-view.js'
import { SearchBox } from '../search-box.js'

export default {
  title: 'Chrome/DataViewers',
  parameters: { layout: 'padded' },
}

// HexView fetches whatever URL it's given.  A data: URL lets the story
// render a real dump with no backend.
const SAMPLE =
  'KBot Studio -- hex view demo.\n' +
  'The quick brown fox jumps over the lazy dog. 0123456789 ABCDEF\n' +
  'Bytes below 0x20 and above 0x7e render as a dot in the ASCII gutter.'

export const Hex = {
  render: () => html`
    <div style="width:680px">
      <${HexView} src=${`data:application/octet-stream;base64,${btoa(SAMPLE)}`} />
    </div>
  `,
}

// SearchBox takes its data source as a prop.  This mock filters a small
// fixed list so the dropdown, keyboard nav, and highlight all work.
const INDEX = [
  { path: 'units/armcom.fbi', name: 'armcom.fbi', isDir: false },
  { path: 'units/corcom.fbi', name: 'corcom.fbi', isDir: false },
  { path: 'units/armcom.cob', name: 'armcom.cob', isDir: false },
  { path: 'units', name: 'units', isDir: true },
  { path: 'gamedata/weapons.tdf', name: 'weapons.tdf', isDir: false },
  { path: 'gamedata/sound.tdf', name: 'sound.tdf', isDir: false },
  { path: 'maps/Comet Catcher.tnt', name: 'Comet Catcher.tnt', isDir: false },
]

const mockSearch = (q) =>
  Promise.resolve(INDEX.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())))

export const Search = {
  render: () => html`
    <div style="width:420px">
      <div style="color:var(--muted);margin-bottom:8px">Type “com”, “tdf”, or “arm”…</div>
      <${SearchBox} onSearch=${mockSearch} onOpenDir=${() => {}} onOpenFile=${() => {}} />
    </div>
  `,
}
