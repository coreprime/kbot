// nano-fx.js
//
// Welcome dialog particle effect, themed by game.
//
// Total Annihilation gets the classic green nanolathe: two emitters at the
// bottom corners fire bright particle streams at the welcome card; on impact
// they burst into sparks and a localised border glow.
//
// TA:Kingdoms — a sorcery-driven world rather than a nano-tech one — gets an
// arcane "conjuration" theme: slow violet/gold smoke wisps rise and waft across
// the card like drifting magical vapour rather than mechanical beams.
//
// The whole thing runs on requestAnimationFrame only while #welcome-dialog is
// visible.  All geometry is computed in the CANVAS's own coordinate space (its
// getBoundingClientRect), NOT the viewport — the welcome surface is repositioned
// (`.as-tab` insets it 82px below the chrome) when shown as a tab, so viewport
// coords would put the emitters and impacts in the wrong place.
//
// The active game is read from window.__KBOT_GAME__ each frame, so the effect
// re-themes the moment session-info resolves at boot.
//
// No state, no host-context — only DOM + canvas + window APIs.

const NANO_THEMES = {
  green: {
    style: 'beam',
    core: 'rgba(220, 255, 200, 1)',
    body: 'rgba(127, 255, 102, 0.9)',
    tail: 'rgba(80, 220, 80, 0.0)',
    hot: (t) => [`rgba(220, 255, 200, ${0.85 * t})`, `rgba(127, 255, 102, ${0.55 * t})`, 'rgba(80, 220, 80, 0)'],
    edge: (t) => `rgba(180, 255, 150, ${0.7 * t})`,
    spark: (t) => `rgba(180, 255, 150, ${t * 0.95})`,
  },
  magical: {
    style: 'smoke',
    // Wisp gradient: warm gold-white core → violet body → transparent.
    smoke: (a) => [`rgba(255, 228, 170, ${a * 0.9})`, `rgba(186, 130, 255, ${a})`, 'rgba(90, 60, 160, 0)'],
  },
}

function nanoTheme() {
  return window.__KBOT_GAME__ === 'takingdoms' ? NANO_THEMES.magical : NANO_THEMES.green
}

export function wireWelcomeNanoFX() {
  const wel = document.querySelector('#welcome-dialog')
  const cv = document.querySelector('#welcome-nanofx')
  if (!wel || !cv) return
  const ctx = cv.getContext('2d')
  let particles = []    // beam particles / smoke wisps fired from the emitters
  let sparks = []       // short-lived sparks at the impact points (beam only)
  let hotspots = []     // localised border glow at recent impacts (beam only)
  let cardRect = null   // card bounds in CANVAS-LOCAL coords for impact checks
  let running = false
  let rafId = 0
  let lastStyle = null  // detect theme-style switches so we can clear particles
  // box = the canvas's own rendered rect, in viewport coords. All particle
  // geometry is relative to box.left/box.top so it stays aligned no matter
  // where the welcome surface sits (full-screen at boot, inset as a tab).
  const box = { left: 0, top: 0, w: 0, h: 0 }
  // Emission budget — fractional carry-over so the rate is frame-rate
  // independent.
  const BEAM_RATE_PER_SIDE = 180
  const SMOKE_RATE_PER_SIDE = 48
  let emitBudgetL = 0, emitBudgetR = 0
  // Sweep phase — drives the beam aim point left↔right across the card.
  let sweepT = 0

  const resize = () => {
    const r = cv.getBoundingClientRect()
    box.left = r.left; box.top = r.top; box.w = r.width; box.h = r.height
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = Math.max(1, Math.round(r.width * dpr))
    cv.height = Math.max(1, Math.round(r.height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  function emitterPoint(side) {
    const margin = 6 // hug the very corners of the canvas
    return side === 'left'
      ? { x: margin, y: box.h - margin }
      : { x: box.w - margin, y: box.h - margin }
  }
  // cardCentre refreshes cardRect (canvas-local) and returns its centre.
  function cardCentre() {
    const card = wel.querySelector('.dialog-card')
    if (!card) { cardRect = null; return null }
    const r = card.getBoundingClientRect()
    cardRect = {
      left: r.left - box.left, top: r.top - box.top,
      right: r.right - box.left, bottom: r.bottom - box.top,
      width: r.width, height: r.height,
    }
    return { x: cardRect.left + cardRect.width / 2, y: cardRect.top + cardRect.height / 2 }
  }

  // sweepAim returns the per-side beam target on the card, phase-offset 180°
  // between sides so the two streams sweep in opposite directions.
  function sweepAim(side) {
    if (!cardRect) return null
    const range = Math.min(cardRect.width * 0.65, 420)
    const phase = side === 'left' ? sweepT : sweepT + Math.PI
    const tx = cardRect.left + cardRect.width / 2 + Math.sin(phase) * range
    const ty = cardRect.top + cardRect.height * 0.5 + Math.cos(phase * 1.7) * Math.min(cardRect.height * 0.45, 110)
    return { x: tx, y: ty }
  }

  // ── Beam emitter (TA / green) ──────────────────────────────────────────
  function emitBeam(side) {
    const src = emitterPoint(side)
    const target = sweepAim(side)
    if (!target) return
    const tx = target.x + (Math.random() - 0.5) * 320
    const ty = target.y + (Math.random() - 0.5) * 220
    const dx = tx - src.x, dy = ty - src.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const targetFlightSec = 0.9
    const speed = Math.max(360, Math.min(2200, len / targetFlightSec)) * (0.85 + Math.random() * 0.3)
    const ttl = Math.max(0.85, (len / speed) * 1.3) + Math.random() * 0.2
    particles.push({
      x: src.x, y: src.y,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      life: 0, ttl,
      size: 0.4 + Math.random() * 0.6,
      side,
    })
  }

  // ── Smoke emitter (TAK / magical) ──────────────────────────────────────
  // Each wisp launches from a corner toward a broadly-scattered target across
  // the whole upper view (including the card), so the smoke fans out across the
  // screen and drifts over the welcome box rather than hugging the corner.
  function emitSmoke(side) {
    const src = emitterPoint(side)
    const cx = cardRect ? cardRect.left + cardRect.width / 2 : box.w / 2
    const cy = cardRect ? cardRect.top + cardRect.height / 2 : box.h * 0.4
    const tx = cx + (Math.random() - 0.5) * box.w * 0.95
    const ty = cy + (Math.random() - 0.5) * box.h * 0.75
    const dx = tx - src.x, dy = ty - src.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const speed = 95 + Math.random() * 105
    particles.push({
      x: src.x, y: src.y,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed - 18,           // slight upward bias (warm air)
      nx: -dy / len, ny: dx / len,           // unit normal, for perpendicular sway
      life: 0, ttl: 3.2 + Math.random() * 2.6,
      r0: 22 + Math.random() * 44,           // base wisp radius
      sway: 0.4 + Math.random() * 0.8,       // sway frequency
      swayAmp: 22 + Math.random() * 34,      // sway amplitude (px/s)
      phase: Math.random() * Math.PI * 2,
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

  function spawnHotspot(x, y, edge) {
    hotspots.push({ x, y, edge, life: 0, ttl: 0.35 })
  }

  function stepBeam(dt) {
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

  function stepSmoke(dt) {
    const keep = []
    for (const p of particles) {
      p.life += dt
      if (p.life >= p.ttl) continue
      // Sway perpendicular to travel so the wisp meanders like real smoke.
      const s = Math.sin(p.life * p.sway + p.phase) * p.swayAmp
      p.x += (p.vx + p.nx * s) * dt
      p.y += (p.vy + p.ny * s) * dt
      p.vx *= (1 - 0.05 * dt) // gradually slow as it disperses
      p.vy *= (1 - 0.05 * dt)
      keep.push(p)
    }
    particles = keep
  }

  function step(dt) {
    const theme = nanoTheme()
    // Clear leftover particles of the other shape when the theme flips so a
    // beam particle never gets drawn with smoke math (or vice-versa).
    if (theme.style !== lastStyle) {
      particles = []; sparks = []; hotspots = []
      lastStyle = theme.style
    }

    sweepT += dt * 1.6
    const rate = theme.style === 'smoke' ? SMOKE_RATE_PER_SIDE : BEAM_RATE_PER_SIDE
    const emitFn = theme.style === 'smoke' ? emitSmoke : emitBeam
    emitBudgetL += dt * rate
    emitBudgetR += dt * rate
    while (emitBudgetL >= 1) { emitFn('left'); emitBudgetL -= 1 }
    while (emitBudgetR >= 1) { emitFn('right'); emitBudgetR -= 1 }

    if (theme.style === 'smoke') stepSmoke(dt)
    else stepBeam(dt)
  }

  function drawSmoke(theme) {
    ctx.save()
    ctx.globalCompositeOperation = 'lighter' // additive: wisps glow, never darken
    for (const p of particles) {
      const t = p.life / p.ttl
      const radius = p.r0 * (1 + t * 1.9)
      // Fade in then out across the wisp's life for soft, breathing vapour.
      const a = Math.sin(Math.min(1, t) * Math.PI) * 0.12
      if (a <= 0.001) continue
      const [c0, c1, c2] = theme.smoke(a)
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius)
      g.addColorStop(0, c0)
      g.addColorStop(0.45, c1)
      g.addColorStop(1, c2)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  function drawBeam(theme) {
    // Beam trails first so sparks + hotspots layer on top.
    for (const p of particles) {
      const src = emitterPoint(p.side)
      const tailDX = src.x - p.x
      const tailDY = src.y - p.y
      const tlen = Math.max(1, Math.hypot(tailDX, tailDY))
      const tailLen = Math.min(14, tlen * 0.08)
      const tx = p.x + (tailDX / tlen) * tailLen
      const ty = p.y + (tailDY / tlen) * tailLen
      const grad = ctx.createLinearGradient(p.x, p.y, tx, ty)
      grad.addColorStop(0, theme.core)
      grad.addColorStop(0.3, theme.body)
      grad.addColorStop(1, theme.tail)
      ctx.strokeStyle = grad
      ctx.lineWidth = p.size
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
    }

    // Hotspots — soft radial glow stuck to the impacted edge segment.
    for (const h of hotspots) {
      const t = 1 - (h.life / h.ttl)
      const radius = 22
      const [c0, c1, c2] = theme.hot(t)
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, radius)
      g.addColorStop(0, c0)
      g.addColorStop(0.4, c1)
      g.addColorStop(1, c2)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2)
      ctx.fill()
      const segLen = 26
      ctx.strokeStyle = theme.edge(t)
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
      ctx.fillStyle = theme.spark(t)
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.size * t + 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function draw() {
    ctx.clearRect(0, 0, box.w, box.h)
    const theme = nanoTheme()
    if (theme.style === 'smoke') drawSmoke(theme)
    else drawBeam(theme)
  }

  let lastTime = 0
  function frame(now) {
    if (!running) return
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0)
    lastTime = now
    cardCentre() // refresh cardRect (canvas-local)
    step(dt)
    draw()
    rafId = requestAnimationFrame(frame)
  }

  function start() {
    if (running) return
    resize() // re-measure: the surface may have been re-inset as a tab
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
    hotspots.length = 0
    ctx.clearRect(0, 0, box.w, box.h)
  }

  // Drive start/stop off the welcome dialog's `hidden` class so the loop only
  // burns frames while the dialog is visible.  MutationObserver catches the
  // programmatic class changes from the tab reveal / startEditor.
  const sync = () => {
    if (wel.classList.contains('hidden')) stop(); else start()
  }
  const obs = new MutationObserver(sync)
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}
