// cob-bytes.js
//
// Fetches a unit's raw COB bytecode for the WebAssembly engine.  The wasm
// module compiles the bytes through the same Go disassembler the server uses,
// so piece animation is derived from one code path on both the browser client
// and the authoritative host.
//
// The engine's spawn resolver and addUnit path are synchronous, so a meta
// object must already carry its `.cob` bytes by the time it reaches the engine.
// Consumers pre-fetch with fetchCobBytes() and stash the result on the meta
// (meta.cob) before handing it to a FrameSource.

// fetchCobBytes resolves a unit name to a Uint8Array of its COB bytecode, or
// null when the unit ships no script (the server answers 404, and the engine
// degrades to a static, script-less unit).  Network/parse failures also yield
// null rather than throwing, so a missing script never blocks a spawn.
export async function fetchCobBytes(name) {
  try {
    const resp = await fetch(`/api/studio/cob-bytes/${encodeURIComponent(name)}`)
    if (!resp.ok) return null
    const buf = await resp.arrayBuffer()
    if (!buf || buf.byteLength === 0) return null
    return new Uint8Array(buf)
  } catch {
    return null
  }
}

// withCobBytes returns a shallow copy of meta with its `.cob` bytes populated
// for the given unit name, leaving the original untouched.  A unit that already
// carries bytes, or that has no script, is returned (copied) unchanged.
export async function withCobBytes(name, meta) {
  const m = { ...(meta || {}) }
  if (!m.name) m.name = name
  if (m.cob) return m
  const cob = await fetchCobBytes(m.name)
  if (cob) m.cob = cob
  return m
}
