// format.js
//
// Small, dependency-free formatting + path helpers shared across the UI
// chrome.  These are pure string/number functions — no DOM, no fetch —
// so they're safe to use anywhere a component needs to render a byte
// count or pick apart a slash-delimited path.

// formatSize renders a byte count as a human-readable size (e.g. 1536 →
// "1.5 KB").  Bytes show whole numbers; larger units get one decimal.
export function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  const val = n / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// parentDir returns the directory portion of a slash-delimited path, or
// '' when the path has no parent (a bare name or the root).
export function parentDir(filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean)
  if (parts.length <= 1) return ''
  return parts.slice(0, -1).join('/')
}

// baseName returns the final segment of a slash-delimited path.
export function baseName(filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

// extOf returns the lower-cased extension (without the dot) of a path's
// final segment, or '' when there's no extension.
export function extOf(filePath) {
  const b = baseName(filePath)
  const i = b.lastIndexOf('.')
  return i < 0 ? '' : b.slice(i + 1).toLowerCase()
}
