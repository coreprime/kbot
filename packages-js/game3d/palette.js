// TAPalette caches the 256-entry RGB palette TA uses to resolve
// `IsColored` primitives (flat-shaded faces with no UV-mapped texture).
// Loaded once per AssetProvider; subsequent model loads reuse the cached
// instance.

import { requireAssetProvider } from './assets.js'

const inflightByProvider = new WeakMap()

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
    const provider = requireAssetProvider()
    const cached = inflightByProvider.get(provider)
    if (cached) return cached
    const inflight = (async () => {
      const triples = await provider.palette()
      return new TAPalette(triples || [])
    })()
    inflightByProvider.set(provider, inflight)
    return inflight
  }
}
