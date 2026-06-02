// file-icons.js
//
// Maps a file name to a glyph and a coarse "kind" used for colour-coding
// rows and choosing a viewer.  Kept tiny and dependency-free so both the
// browse table and the search dropdown can share it.

import { extOf } from './format.js'

const ICONS = {
  gaf: '🎨', pcx: '🖼️', pal: '🎨',
  wav: '🔊', mp3: '🎵',
  smk: '🎬', zrb: '🎬', bik: '🎬',
  cob: '⚙️',
  bos: '📝', h: '📝',
  tdf: '📋', fbi: '📋', gui: '📋', ota: '📋',
  tnt: '🗺️', sct: '🗺️',
  fnt: '🔤',
  ai: '🧠', txt: '📄',
  '3do': '🧊',
  hpi: '📦', ufo: '📦', ccx: '📦', gp3: '📦',
  crt: '🎯',
}

const KINDS = {
  gaf: 'image', pcx: 'image', fnt: 'image', tnt: 'map', sct: 'map',
  pal: 'palette', crt: 'data', '3do': 'model',
  wav: 'audio', mp3: 'audio', smk: 'video', zrb: 'video', bik: 'video',
  cob: 'code', bos: 'code', h: 'code',
  tdf: 'config', fbi: 'config', gui: 'config', ota: 'config',
  ai: 'ai', hpi: 'archive', ufo: 'archive', ccx: 'archive', gp3: 'archive',
}

export function fileIcon(name) {
  return ICONS[extOf(name)] || '📄'
}

export function fileKind(name) {
  return KINDS[extOf(name)] || 'file'
}
