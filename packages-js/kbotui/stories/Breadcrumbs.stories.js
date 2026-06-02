import { html } from '../index.js'
import { Breadcrumbs } from '../breadcrumbs.js'

export default {
  title: 'Chrome/Breadcrumbs',
  parameters: { layout: 'padded' },
}

const CRUMBS = [
  { name: 'Root', path: '' },
  { name: 'units', path: 'units' },
  { name: 'armcom', path: 'units/armcom' },
]

// A path rendered as clickable segments, with a "File System" home
// crumb leading the trail and the final segment inert.
export const Folder = {
  render: () => html`
    <${Breadcrumbs}
      crumbs=${CRUMBS}
      onOpenDir=${() => {}}
      onGoHome=${() => {}}
    />
  `,
}

// A file location: the directory trail plus an inert trailing filename.
export const File = {
  render: () => html`
    <${Breadcrumbs}
      crumbs=${CRUMBS}
      trailing="armcom.fbi"
      onOpenDir=${() => {}}
      onGoHome=${() => {}}
    />
  `,
}

// The filesystem root renders as "/ (Root)".
export const AtRoot = {
  render: () => html`
    <${Breadcrumbs} crumbs=${[{ name: 'Root', path: '' }]} onGoHome=${() => {}} />
  `,
}
