// nano-fx.js
//
// Welcome dialog nanolathe particle effect.
//
// Two emitters at the bottom-left + bottom-right of the viewport
// fire bright-green particle streams toward the centre of the
// welcome dialog card.  On impact the particles burst into
// short-lived sparks that scatter along the card edge, and the
// card itself briefly pulses a green glow via a localised
// hotspot.  Pure visual fluff while the user picks New vs Open.
//
// The whole thing runs on requestAnimationFrame only while the
// welcome dialog is visible — wireWelcomeNanoFX() starts the loop
// at boot, and the loop self-suspends when #welcome-dialog gets
// the `hidden` class.
//
// No state, no host-context — only DOM + canvas + window APIs.

const NANO_GREEN_CORE = 'rgba(220, 255, 200, 1)'
const NANO_GREEN_BODY = 'rgba(127, 255, 102, 0.9)'
const NANO_GREEN_TAIL = 'rgba(80, 220, 80, 0.0)'

export function wireWelcomeNanoFX() {
  const wel = document.querySelector('#welcome-dialog')
  const cv = document.querySelector('#welcome-nanofx')
  if (!wel || !cv) return
  const ctx = cv.getContext('2d')
  let particles = []    // beam particles fired from the emitters
  let sparks = []       // short-lived sparks at the impact points
  let hotspots = []     // localised border glow at recent impacts
  let cardRect = null   // cached card bounding rect for impact checks
  let running = false
  let rafId = 0
  // Emission budget — fractional carry-over so the rate is
  // frame-rate independent.  ~180 beams/sec/side so the cloud
  // reads as a true spray, paired with the smaller per-particle
  // size below so the total ink on screen stays manageable.
  const EMIT_RATE_PER_SIDE = 180
  let emitBudgetL = 0, emitBudgetR = 0
  // Sweep phase — drives the aim point left↔right across the
  // card so each emitter behaves like a spray-can sweeping a
  // stripe of particles onto the dialog edge.  Counter-phase per
  // side.
  let sweepT = 0

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = Math.round(window.innerWidth * dpr)
    cv.height = Math.round(window.innerHeight * dpr)
    cv.style.width = window.innerWidth + 'px'
    cv.style.height = window.innerHeight + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  function emitterPoint(side) {
    const margin = 40
    return side === 'left'
      ? { x: margin, y: window.innerHeight - margin }
      : { x: window.innerWidth - margin, y: window.innerHeight - margin }
  }
  function cardCentre() {
    const card = wel.querySelector('.dialog-card')
    if (!card) return null
    const r = card.getBoundingClientRect()
    cardRect = r
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  // sweepAim returns the per-side target on the card.  Phase is
  // offset 180° between sides so the two streams sweep in
  // opposite directions (each painting from its near edge across).
  function sweepAim(side) {
    if (!cardRect) return null
    // Sweep nearly the full card width, capped so very wide
    // viewports don't send the streams off to the corners.
    const range = Math.min(cardRect.width * 0.65, 420)
    const phase = side === 'left' ? sweepT : sweepT + Math.PI
    const tx = cardRect.left + cardRect.width / 2 + Math.sin(phase) * range
    const ty = cardRect.top + cardRect.height * 0.5 + Math.cos(phase * 1.7) * Math.min(cardRect.height * 0.45, 110)
    return { x: tx, y: ty }
  }

  function emit(side) {
    const src = emitterPoint(side)
    const target = sweepAim(side)
    if (!target) return
    // Big cone of jitter — turns each emission into a dust cloud
    // rather than a tracked beam.  The wider the jitter, the more
    // the per-particle paths fan out across the card edge.
    const tx = target.x + (Math.random() - 0.5) * 320
    const ty = target.y + (Math.random() - 0.5) * 220
    const dx = tx - src.x, dy = ty - src.y
    const len = Math.max(1, Math.hypot(dx, dy))
    // Speed and TTL both scale with the actual flight distance —
    // on a 4K display the corner-to-card hop is ~1500px, well
    // past the old fixed 800px reach, so the beams used to
    // fizzle in mid-air.  Target flight time of ~0.9s regardless
    // of viewport: speed ≈ distance / 0.9, clamped to keep
    // small-screen speeds reasonable.
    const targetFlightSec = 0.9
    const speed = Math.max(360, Math.min(2200, len / targetFlightSec)) * (0.85 + Math.random() * 0.3)
    // TTL has to outlast the actual flight or the particle dies
    // en route.  Headroom of ~30% covers the random speed variance.
    const ttl = Math.max(0.85, (len / speed) * 1.3) + Math.random() * 0.2
    particles.push({
      x: src.x, y: src.y,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      life: 0, ttl,
      // Far smaller dots so the higher density doesn't read as a
      // solid green plate — individual sparks of nanolathe dust.
      size: 0.4 + Math.random() * 0.6,
      side,
    })
  }

  function spawnSparks(x, y) {
    const count = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 70 + Math.random() * 130
      sparks.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 60,
        life: 0, ttl: 0.30 + Math.random() * 0.30,
        size: 1.2 + Math.random() * 1.2,
      })
    }
  }

  // Hotspot = a soft glow blob anchored to a specific point on
  // the card edge.  Replaces the previous "entire card flashes"
  // CSS animation — only the bit of border the particle actually
  // hit brightens, and it fades over ~350ms.
  function spawnHotspot(x, y, edge) {
    hotspots.push({ x, y, edge, life: 0, ttl: 0.35 })
  }

  function step(dt) {
    sweepT += dt * 1.6 // rad/sec; full sweep cycle ≈ 4s

    emitBudgetL += dt * EMIT_RATE_PER_SIDE
    emitBudgetR += dt * EMIT_RATE_PER_SIDE
    while (emitBudgetL >= 1) { emit('left'); emitBudgetL -= 1 }
    while (emitBudgetR >= 1) { emit('right'); emitBudgetR -= 1 }

    const keep = []
    for (const p of particles) {
      p.life += dt
      if (p.life >= p.ttl) continue
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (cardRect && p.x >= cardRect.left && p.x <= cardRect.right
          && p.y >= cardRect.top && p.y <= cardRect.bottom) {
        const dl = p.x - cardRect.left
        const dr = cardRect.right - p.x
        const dt2 = p.y - cardRect.top
        const db = cardRect.bottom - p.y
        const m = Math.min(dl, dr, dt2, db)
        let ix = p.x, iy = p.y, edge
        if (m === dl) { ix = cardRect.left; edge = 'left' }
        else if (m === dr) { ix = cardRect.right; edge = 'right' }
        else if (m === dt2) { iy = cardRect.top; edge = 'top' }
        else { iy = cardRect.bottom; edge = 'bottom' }
        spawnSparks(ix, iy)
        spawnHotspot(ix, iy, edge)
        continue
      }
      keep.push(p)
    }
    particles = keep

    const keepSparks = []
    for (const s of sparks) {
      s.life += dt
      if (s.life >= s.ttl) continue
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vy += 220 * dt
      keepSparks.push(s)
    }
    sparks = keepSparks

    const keepHots = []
    for (const h of hotspots) {
      h.life += dt
      if (h.life >= h.ttl) continue
      keepHots.push(h)
    }
    hotspots = keepHots
  }

  function draw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

    // Beam trails first so sparks + hotspots layer on top.
    for (const p of particles) {
      const src = emitterPoint(p.side)
      const tailDX = src.x - p.x
      const tailDY = src.y - p.y
      const tlen = Math.max(1, Math.hypot(tailDX, tailDY))
      // Shorter tail — the dots are far smaller now, so a long
      // streak would dominate the frame and undo the dust look.
      const tailLen = Math.min(14, tlen * 0.08)
      const tx = p.x + (tailDX / tlen) * tailLen
      const ty = p.y + (tailDY / tlen) * tailLen
      const grad = ctx.createLinearGradient(p.x, p.y, tx, ty)
      grad.addColorStop(0, NANO_GREEN_CORE)
      grad.addColorStop(0.3, NANO_GREEN_BODY)
      grad.addColorStop(1, NANO_GREEN_TAIL)
      ctx.strokeStyle = grad
      ctx.lineWidth = p.size
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
    }

    // Hotspots — soft radial glow stuck to the impacted edge
    // segment.  Only the bit of border the particle hit
    // brightens; the rest of the card frame stays dark.
    for (const h of hotspots) {
      const t = 1 - (h.life / h.ttl)
      const radius = 22
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, radius)
      g.addColorStop(0, `rgba(220, 255, 200, ${0.85 * t})`)
      g.addColorStop(0.4, `rgba(127, 255, 102, ${0.55 * t})`)
      g.addColorStop(1, 'rgba(80, 220, 80, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2)
      ctx.fill()
      // Thin bright line along the impacted edge to read as a
      // flash on the dialog border, not just a generic blob in
      // mid-air.
      const segLen = 26
      ctx.strokeStyle = `rgba(180, 255, 150, ${0.7 * t})`
      ctx.lineWidth = 2
      ctx.beginPath()
      if (h.edge === 'top' || h.edge === 'bottom') {
        ctx.moveTo(h.x - segLen / 2, h.y)
        ctx.lineTo(h.x + segLen / 2, h.y)
      } else {
        ctx.moveTo(h.x, h.y - segLen / 2)
        ctx.lineTo(h.x, h.y + segLen / 2)
      }
      ctx.stroke()
    }

    // Sparks last.
    for (const s of sparks) {
      const t = 1 - (s.life / s.ttl)
      ctx.fillStyle = `rgba(180, 255, 150, ${t * 0.95})`
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.size * t + 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  let lastTime = 0
  function frame(now) {
    if (!running) return
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0)
    lastTime = now
    cardCentre() // refresh cardRect
    step(dt)
    draw()
    rafId = requestAnimationFrame(frame)
  }

  function start() {
    if (running) return
    running = true
    lastTime = performance.now()
    rafId = requestAnimationFrame(frame)
  }
  function stop() {
    if (!running) return
    running = false
    cancelAnimationFrame(rafId)
    particles.length = 0
    sparks.length = 0
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  }

  // Drive start/stop off the welcome dialog's `hidden` class so
  // the loop only burns frames while the user is actually
  // looking at the dialog.  MutationObserver catches programmatic
  // class changes from startEditor / openLoadedMap.
  const sync = () => {
    if (wel.classList.contains('hidden')) stop(); else start()
  }
  const obs = new MutationObserver(sync)
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}
