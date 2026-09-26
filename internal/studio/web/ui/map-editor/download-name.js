// download-name.js
//
// downloadName reads the file name the server gave a download in its
// Content-Disposition header, so the browser saves a map archive under
// the name (and extension) the server chose: .ufo for Total Annihilation
// maps, which TA 3.1c mounts above every .hpi, .hpi for TA: Kingdoms.

export function downloadName(header, fallback) {
  const h = String(header || '')
  const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(h)
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1') || fallback
  const bare = /filename=([^;]+)/i.exec(h)
  if (bare) return bare[1].trim() || fallback
  return fallback
}
