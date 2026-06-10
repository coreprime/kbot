// glamour.js
//
// Welcome screen background slideshow. The hub's /api/studio/glamour/list
// returns a list of ready-to-use image URLs for the session's game —
// Total Annihilation's bitmaps/glamour/ splash art, or (for titles that
// ship none, e.g. TA: Kingdoms) map preview minimaps. We fade through
// them behind the welcome card, rotating every WELCOME_GLAMOUR_INTERVAL_MS.
// The next image is loaded into a hidden <img> first; only after it
// decodes do we cross-fade, so the user never sees a partial paint.
// Images that fail to load (a map without an embedded minimap) are skipped.
//
// Mounts on #welcome-glamour-a / #welcome-glamour-b — two overlapping
// <img>s the CSS cross-fades between via a `.visible` class. Drives
// start/stop off #welcome-dialog's `hidden` class so the timer only
// fires while the user is actually looking at the welcome screen.

import { $ } from '../../../host-context.js'

const WELCOME_GLAMOUR_INTERVAL_MS = 15000

export function wireWelcomeGlamour() {
  const wel = $('#welcome-dialog')
  const imgA = $('#welcome-glamour-a')
  const imgB = $('#welcome-glamour-b')
  if (!wel || !imgA || !imgB) return
  let urls = []
  let order = []          // shuffled index list — exhausted before reshuffle so we cycle without repeats
  let active = imgA       // currently-visible <img>
  let standby = imgB      // the one we paint into next
  let timer = 0
  let started = false

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }
  const nextURL = () => {
    if (urls.length === 0) return null
    if (order.length === 0) {
      order = shuffle([...urls.keys()])
      // Avoid repeating the just-shown image back-to-back when the
      // reshuffle happens to put it first.
      const lastSrc = active.src
      if (urls.length > 1 && order.length > 0) {
        const top = urls[order[0]]
        if (top && lastSrc.endsWith(top)) {
          order.push(order.shift())
        }
      }
    }
    return urls[order.shift()]
  }
  const swap = () => {
    const tmp = active
    active = standby
    standby = tmp
  }
  // loadInto points img at url and resolves true once it has decoded to a
  // real bitmap, false on any load/decode error (so callers can skip it).
  async function loadInto(img, url) {
    img.src = url
    try {
      if (typeof img.decode === 'function') {
        await img.decode()
      } else {
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej })
      }
    } catch {
      return false
    }
    return img.naturalWidth > 0
  }
  async function tick() {
    // Try a few candidates so a run of minimap-less maps doesn't stall
    // the rotation.
    for (let tries = 0; tries < 6; tries++) {
      const url = nextURL()
      if (!url) return
      const ok = await loadInto(standby, url)
      if (wel.classList.contains('hidden')) return // dialog closed mid-load
      if (ok) {
        standby.classList.add('visible')
        active.classList.remove('visible')
        swap()
        return
      }
    }
  }
  async function start() {
    if (started) return
    started = true
    try {
      const resp = await fetch('/api/studio/glamour/list')
      if (!resp.ok) return
      const data = await resp.json()
      urls = Array.isArray(data.images) ? data.images : []
    } catch { return }
    if (urls.length === 0) return
    // First image: find one that actually loads, then fade it in.
    for (let tries = 0; tries < 6; tries++) {
      const url = nextURL()
      if (!url) return
      const ok = await loadInto(active, url)
      if (wel.classList.contains('hidden')) return
      if (ok) {
        active.classList.add('visible')
        break
      }
    }
    timer = setInterval(tick, WELCOME_GLAMOUR_INTERVAL_MS)
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = 0 }
  }
  // Drive start/stop off the dialog's `hidden` class — the slideshow
  // only fires while the user is looking at the welcome screen.
  const sync = () => {
    if (wel.classList.contains('hidden')) stop()
    else start()
  }
  const obs = new MutationObserver(sync)
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}
