// TAPalette caches the 256-entry RGB palette TA uses to resolve
// `IsColored` primitives (flat-shaded faces with no UV-mapped texture).
// Loaded once per page session from /api/studio/palette; subsequent
// model loads reuse the cached instance.

let inflight = null

export class TAPalette {
  constructor(rgbTriples) {
    this.entries = rgbTriples
  }

  // colorFor returns an [r, g, b, 1] tuple in 0..1 float range, suitable
  // for direct upload to a shader uniform.
  colorFor(index) {
    const e = this.entries[index & 0xff] || [0x80, 0x80, 0x80]
    return [e[0] / 255, e[1] / 255, e[2] / 255, 1]
  }

  static async load() {
    if (inflight) return inflight
    inflight = (async () => {
      const resp = await fetch('/api/studio/palette')
      if (!resp.ok) throw new Error(`palette fetch failed: HTTP ${resp.status}`)
      const json = await resp.json()
      return new TAPalette(json.palette || [])
    })()
    return inflight
  }
}
