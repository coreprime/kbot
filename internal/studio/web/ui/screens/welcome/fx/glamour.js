// glamour.js
//
// Welcome screen background slideshow.  TA ships ~50 splash PCXs
// under bitmaps/glamour/.  We fade through them behind the welcome
// card, rotating every WELCOME_GLAMOUR_INTERVAL_MS.  The next
// image is fetched into a hidden <img> first; only after
// `decode()` resolves do we cross-fade, so the user never sees a
// partial paint.
//
// Mounts on #welcome-glamour-a / #welcome-glamour-b — two
// overlapping <img>s the CSS cross-fades between via a `.visible`
// class.  Drives start/stop off #welcome-dialog's `hidden` class
// (same pattern the nanofx loop uses) so the timer only fires
// while the user is actually looking at the welcome screen.

import { $ } from '../../../host-context.js'

const WELCOME_GLAMOUR_INTERVAL_MS = 15000

export function wireWelcomeGlamour() {
  const wel = $('#welcome-dialog')
  const imgA = $('#welcome-glamour-a')
  const imgB = $('#welcome-glamour-b')
  if (!wel || !imgA || !imgB) return
  let slugs = []
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
  const nextSlug = () => {
    if (slugs.length === 0) return null
    if (order.length === 0) {
      order = shuffle([...slugs.keys()])
      // Avoid repeating the just-shown slug back-to-back when the
      // reshuffle happens to put it first.
      const lastSrc = active.src
      if (slugs.length > 1 && order.length > 0) {
        const top = slugs[order[0]]
        if (top && lastSrc.endsWith('/' + top)) {
          // Rotate one off the front to break the repeat.
          order.push(order.shift())
        }
      }
    }
    return slugs[order.shift()]
  }
  const swap = () => {
    const tmp = active
    active = standby
    standby = tmp
  }
  async function loadInto(img, slug) {
    img.src = `/api/studio/glamour/image/${encodeURIComponent(slug)}`
    if (typeof img.decode === 'function') {
      try { await img.decode() } catch { /* fall back to natural load */ }
    } else {
      await new Promise((r) => { img.onload = r; img.onerror = r })
    }
  }
  async function tick() {
    const slug = nextSlug()
    if (!slug) return
    await loadInto(standby, slug)
    if (wel.classList.contains('hidden')) return // dialog closed mid-load
    standby.classList.add('visible')
    active.classList.remove('visible')
    swap()
  }
  async function start() {
    if (started) return
    started = true
    try {
      const resp = await fetch('/api/studio/glamour/list')
      if (!resp.ok) return
      const data = await resp.json()
      slugs = Array.isArray(data.images) ? data.images : []
    } catch { return }
    if (slugs.length === 0) return
    // First image: load, then fade in.
    const slug = nextSlug()
    if (!slug) return
    await loadInto(active, slug)
    if (wel.classList.contains('hidden')) return
    active.classList.add('visible')
    timer = setInterval(tick, WELCOME_GLAMOUR_INTERVAL_MS)
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = 0 }
  }
  // Drive start/stop off the dialog's `hidden` class — same
  // pattern the nanofx loop uses.  The slideshow only fires while
  // the user is actually looking at the welcome screen.
  const sync = () => {
    if (wel.classList.contains('hidden')) stop()
    else start()
  }
  const obs = new MutationObserver(sync)
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}
