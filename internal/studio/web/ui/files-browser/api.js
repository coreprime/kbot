// api.js
//
// Client for the studio VFS surface (/api/vfs/).  The whole explorer
// talks to one dispatcher: a trailing slash lists a directory, query
// flags (?stats / ?q / ?metadata / ?describe / ?layering) ask for the
// various JSON documents, and render params (format / view / sequence /
// frame / text / palette / transparency / source) ask for an encoded
// representation (PNG, APNG, GIF, minimap, transcoded video …).  Bare
// paths serve the raw bytes.
//
// The render-URL builders below hide that query-param shape so the
// viewers can ask for "the PNG of GAF sequence 3, frame 2, with the
// unit's team palette" without hand-assembling a query string.

const BASE = '/api/vfs/'

// enc encodes a VFS-relative path for use in the dispatcher URL,
// preserving the slashes that delimit folders.
function enc(p) {
  return String(p || '').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')
}

// qs turns an object into a query string, dropping empty / null values
// so an unset palette or source doesn't add a stray "&palette=".
function qs(params) {
  const parts = []
  for (const [k, v] of Object.entries(params || {})) {
    if (v === '' || v == null) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// ── JSON documents ──────────────────────────────────────────────────

export function getStats() {
  return fetchJSON(`${BASE}?stats`)
}

export function search(query) {
  return fetchJSON(`${BASE}?q=${encodeURIComponent(query)}`).then((d) => d.results || [])
}

export function browse(dir) {
  const clean = enc(dir)
  return fetchJSON(`${BASE}${clean}${clean ? '/' : ''}`)
}

export function metadata(path) {
  return fetchJSON(`${BASE}${enc(path)}?metadata`)
}

export function describe(path) {
  return fetchJSON(`${BASE}${enc(path)}?describe`)
}

export function layering(path) {
  return fetchJSON(`${BASE}${enc(path)}?layering`)
}

// ── byte / representation URLs ──────────────────────────────────────

// rawURL serves the file's bytes verbatim — used for natively
// browser-renderable assets (png/jpg/gif), audio, and downloads, and as
// the source for the hex view.  `source` pins a specific archive layer.
export function rawURL(path, source) {
  return `${BASE}${enc(path)}${qs({ source })}`
}

// renderURL is the generic representation builder; the typed helpers
// below wrap it for each format so callers stay declarative.
export function renderURL(path, params) {
  return `${BASE}${enc(path)}${qs(params)}`
}

export function gafPngURL(path, seq, frame, palette, transparency, source) {
  return renderURL(path, { format: 'png', sequence: seq, frame, palette, transparency, source })
}

export function gafApngURL(path, seq, palette, transparency, source) {
  return renderURL(path, { format: 'apng', sequence: seq, palette, transparency, source })
}

export function gafGifURL(path, seq, palette, transparency, source) {
  return renderURL(path, { format: 'gif', sequence: seq, palette, transparency, source })
}

export function pcxURL(path, palette, source) {
  return renderURL(path, { format: 'png', palette, source })
}

export function imageURL(path, format, source) {
  return renderURL(path, { format: format || 'png', source })
}

export function mapViewURL(path, view, source) {
  return renderURL(path, { view: view || 'minimap', source })
}

export function fntSheetURL(path, source) {
  return renderURL(path, { format: 'png', source })
}

export function fntTextURL(path, text, source) {
  return renderURL(path, { text: text || ' ', source })
}

export function videoURL(path, source) {
  return renderURL(path, { format: 'mp4', source })
}

export function videoThumbURL(path, source) {
  return renderURL(path, { format: 'thumb', source })
}

// ── formatting ──────────────────────────────────────────────────────

export function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  const val = n / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function parentDir(filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

export function baseName(filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export function extOf(filePath) {
  const b = baseName(filePath)
  const i = b.lastIndexOf('.')
  return i < 0 ? '' : b.slice(i + 1).toLowerCase()
}
