package sim

import "github.com/coreprime/kbot/engine/fixed"

// This file is the per-tick flight simulation for weapons that carry a 3DO
// model — the missiles, rockets and bombs whose projectile is a real mesh.
// Lasers, plain bullets and shells with no model resolve their damage instantly
// at fire time; this subsystem exists for the ones the player can see fly.
//
// Everything here is integer fixed-point through engine/fixed, so a missile
// flies bit-identically on the authoritative host and on every predicting
// client. Headings and pitch are raw TA-angles (65536 per turn); the renderer
// convention is heading 0 = +Z, forward = (sin h, cos h) on the ground plane
// and pitch lifts toward +Y.

// TA-angle landmarks used as flight thresholds.
const (
	quarterTurn int32 = 1 << 14 // 16384, a 90° pitch (straight up)
	halfTurn    int32 = 1 << 15 // 32768, the default homing rate (≈π rad/s)
)

// taAnglesPerRadian converts a TA-angle turn rate into a physical turn radius.
// A homing rate of turnAng TA-angle/sec is ω = turnAng·2π/65536 rad/sec, so the
// arc radius at a given speed is speed/ω = speed·(65536/2π)/turnAng. Without the
// 65536/2π factor the radius collapses to a fraction of a world unit and a
// vertical-launch missile pitches over on its first tick — no ascent at all.
const taAnglesPerRadian = 65536.0 / 6.283185307179586 // ≈ 10430.378

// projMode is the flight behaviour selected from the weapon TDF flags.
type projMode uint8

const (
	projStraight    projMode = iota // constant-heading powered shot (unguided rockets)
	projDropped                     // gravity bomb: released with no thrust
	projVLaunch                     // vertical launch: climbs, then pitches over and homes
	projGuided                      // self-propelled + tracking: homes on the target
	projBallistic                   // unpowered arc under gravity (mortars)
	projBurstParent                 // static invisible burst emitter: clones pellets, never flies
)

// String names the flight mode for the inspection snapshot the studio's
// Projectiles panel labels each shot with.
func (m projMode) String() string {
	switch m {
	case projDropped:
		return "dropped"
	case projVLaunch:
		return "vlaunch"
	case projGuided:
		return "guided"
	case projBallistic:
		return "ballistic"
	case projBurstParent:
		return "burst"
	default:
		return "straight"
	}
}

// projPhase tracks the two-stage flight of a vertical-launch missile.
type projPhase uint8

const (
	phaseCruise projPhase = iota
	phaseAscent
	phaseHome
)

// projectile is one in-flight model weapon. Orientation (heading/pitch) is the
// source of truth between ticks: deriving spherical angles from velocity blows
// up near the vertical singularity (vlaunch ascent, the first homing ticks), so
// the steered modes write the angles directly and rebuild velocity from them.
type projectile struct {
	id       uint32
	ownerID  uint32
	targetID uint32 // 0 = fixed point target
	slot     int
	mode     projMode
	phase    projPhase
	model    string
	weapon   string

	pos     fixed.Vec3
	vel     fixed.Vec3
	origin  fixed.Vec3
	target  fixed.Vec3
	launchY fixed.Fixed

	speed   fixed.Fixed
	vmax    fixed.Fixed
	accel   fixed.Fixed
	turnAng int32       // homing turn rate, TA-angle/sec; 0 = unguided
	homingR fixed.Fixed // physical turn radius at top speed (ascent height + fuze window)
	gravity fixed.Fixed
	aoe     fixed.Fixed // blast diameter
	damage  fixed.Fixed

	ageSec  fixed.Fixed
	lifeSec fixed.Fixed

	// Proximity-fuze state for steered shots: a missile whose turn radius is
	// wider than the kill radius closes on the target then sweeps past it; we
	// detonate at that closest pass instead of letting it orbit. closing latches
	// once the range starts dropping so the outbound ascent doesn't false-trigger.
	lastDistT fixed.Fixed
	closing   bool

	heading int32
	pitch   int32
	dead    bool
	hit     bool // true on the tick it reaches the target (vs. timing out)

	// fromPiece is the emitter piece index the slot's Query script returned at
	// launch. The sim has no geometry so it spawns from the unit origin; this is
	// carried purely so the renderer can offset the model to the real muzzle.
	fromPiece int

	// wm carries the launching weapon's full stat block so detonation can
	// resolve the per-target damage table, splash falloff and shooter rule
	// even after the firing unit is gone.
	wm WeaponMeta

	// Burst-parent bookkeeping: pellets left, the tick spacing, and ticks
	// since the last emission. The parent sits at the muzzle emitting one
	// flying pellet every burstGap ticks; it is removed once the count runs
	// out. Zero on ordinary shots.
	burstLeft  int
	burstGap   int
	burstSince int
}

// projectileModeFor picks a flight behaviour from the weapon flags.
func projectileModeFor(w WeaponMeta) projMode {
	switch {
	case w.Dropped:
		return projDropped
	case w.VLaunch:
		return projVLaunch
	case (w.Tracks || w.SelfProp) && w.TurnRateAng > 0:
		return projGuided
	case w.Ballistic:
		return projBallistic
	default:
		return projStraight
	}
}

// velFromAngles rebuilds a velocity vector from heading, pitch and speed.
func velFromAngles(heading, pitch int32, speed fixed.Fixed) fixed.Vec3 {
	sh, ch := fixed.SinCos(fixed.NormalizeAngle(heading))
	sp, cp := fixed.SinCos(fixed.NormalizeAngle(pitch))
	return fixed.Vec3{
		X: sh.Mul(cp).Mul(speed),
		Y: sp.Mul(speed),
		Z: ch.Mul(cp).Mul(speed),
	}
}

// hypot3 is the 3D magnitude, composed from the 2D fixed-point Hypot.
func hypot3(x, y, z fixed.Fixed) fixed.Fixed {
	return fixed.Hypot(fixed.Hypot(x, z), y)
}

// makeProjectile builds the flight record for one shot. anchor is the muzzle
// exit, target the aim point; gravity is the world gravity for arcing modes.
func (w *World) makeProjectile(ownerID, targetID uint32, slot int, wm WeaponMeta, anchor, target fixed.Vec3, fromPiece int) *projectile {
	mode := projectileModeFor(wm)

	vmax := wm.VelocityWU
	if vmax <= 0 {
		vmax = fixed.FromInt(200)
	}
	speed0 := wm.StartVelocityWU
	if speed0 <= 0 {
		if mode == projDropped {
			speed0 = 0
		} else {
			speed0 = vmax
		}
	}

	dx := target.X - anchor.X
	dy := target.Y - anchor.Y
	dz := target.Z - anchor.Z
	d := hypot3(dx, dy, dz)
	if d <= 0 {
		d = fixed.One
	}

	var vel fixed.Vec3
	switch mode {
	case projVLaunch:
		vel = fixed.Vec3{Y: fixed.Max(fixed.One, speed0)} // straight up off the rail
	case projDropped:
		vel = fixed.Vec3{} // bombs fall straight; no inherited thrust
	case projBallistic:
		// Gravity-arc launch: the closed-form elevation solve picks the low
		// arc that intercepts the target under this world's gravity. The
		// launch velocity carries the whole solution — flight is then pure
		// pos += vel; vy −= g integration. Two engine refinements are
		// deliberately absent pending resolved constants: the launch droop
		// pre-compensation term (its per-slot source value is unresolved)
		// and the wind vector (whose 5-10 s re-roll would also consume
		// shared-stream draws); both are sub-tick landing-point trims.
		horiz := fixed.Hypot(dx, dz)
		if vh, vy, ok := solveBallisticLaunch(
			horiz.Float(), (anchor.Y - target.Y).Float(),
			vmax.Float(), w.gravity.Float(), wm.MinBarrelSin); ok && horiz > 0 {
			vel = fixed.Vec3{
				X: dx.Mul(fixed.FromFloat(vh)).Div(horiz),
				Y: fixed.FromFloat(vy),
				Z: dz.Mul(fixed.FromFloat(vh)).Div(horiz),
			}
		} else {
			// No solvable arc (the fire gate normally rejects this shot
			// before launch): degrade to a direct lob at the target.
			vel = fixed.Vec3{
				X: dx.Mul(speed0).Div(d),
				Y: dy.Mul(speed0).Div(d),
				Z: dz.Mul(speed0).Div(d),
			}
		}
	default:
		vel = fixed.Vec3{
			X: dx.Mul(speed0).Div(d),
			Y: dy.Mul(speed0).Div(d),
			Z: dz.Mul(speed0).Div(d),
		}
	}

	// Seed orientation from the bearing to the target so a vlaunch/dropped shot
	// (which has no horizontal launch velocity) still points where it will fly.
	eps := fixed.FromFloat(0.001)
	horizT := fixed.Hypot(dx, dz)
	headingInit := int32(0)
	if horizT > eps {
		headingInit = fixed.Atan2(dx, dz)
	}
	horiz0 := fixed.Hypot(vel.X, vel.Z)
	var pitchInit int32
	switch {
	case horiz0 > fixed.One:
		pitchInit = fixed.Atan2(vel.Y, horiz0)
	case mode == projVLaunch:
		pitchInit = quarterTurn
	default:
		denom := horizT
		if denom <= 0 {
			denom = fixed.One
		}
		pitchInit = fixed.Atan2(dy, denom)
	}

	// Lifetime: the TDF timer if given, else time-of-flight at top speed over
	// the weapon range, with extra slack for arcing/homing paths.
	rng := wm.Range
	if rng <= 0 {
		rng = vmax.Mul(fixed.FromInt(3))
	}
	slack := fixed.FromFloat(1.2)
	switch mode {
	case projBallistic, projDropped:
		slack = fixed.FromFloat(1.6)
	case projGuided, projVLaunch:
		slack = fixed.FromFloat(1.4)
	}
	lifeSec := wm.FlightTimeSec
	if lifeSec <= 0 {
		lifeSec = fixed.Max(fixed.FromFloat(0.4), rng.Div(vmax).Mul(slack))
	}
	if mode == projBallistic {
		// An arc's flight time exceeds range/velocity (the shot travels the
		// curve, not the chord); give it the full time-of-flight with slack
		// so a legal shell never expires mid-arc. Ground impact and target
		// arrival are the real terminators.
		horiz := fixed.Hypot(dx, dz)
		if vel.X != 0 || vel.Z != 0 {
			if vh := fixed.Hypot(vel.X, vel.Z); vh > 0 {
				lifeSec = fixed.Max(lifeSec, horiz.Div(vh).Mul(fixed.FromInt(2)))
			}
		}
	}

	grav := fixed.Zero
	if mode == projBallistic || mode == projDropped {
		grav = w.gravity
	}
	phase := phaseCruise
	if mode == projVLaunch {
		phase = phaseAscent
	}
	dmg := wm.Damage
	if dmg <= 0 {
		dmg = defaultHitDamage
	}

	// Physical homing turn radius at top speed: ω = turnAng·2π/65536 rad/s, so
	// radius = vmax/ω. Doubles as the vlaunch ascent height and the proximity-
	// fuze capture window for a missile that can't turn tighter than this.
	var homingR fixed.Fixed
	if wm.TurnRateAng > 0 {
		homingR = vmax.Mul(fixed.FromFloat(taAnglesPerRadian)).Div(fixed.FromInt(int(wm.TurnRateAng)))
	}

	return &projectile{
		wm:        wm,
		id:        w.nextProjID,
		ownerID:   ownerID,
		targetID:  targetID,
		slot:      slot,
		mode:      mode,
		phase:     phase,
		model:     wm.Model,
		weapon:    wm.Name,
		pos:       anchor,
		vel:       vel,
		origin:    anchor,
		target:    target,
		launchY:   anchor.Y,
		speed:     hypot3(vel.X, vel.Y, vel.Z),
		vmax:      vmax,
		accel:     wm.AccelerationWU,
		turnAng:   wm.TurnRateAng,
		homingR:   homingR,
		gravity:   grav,
		aoe:       wm.AreaOfEffectWU,
		damage:    dmg,
		lifeSec:   lifeSec,
		heading:   headingInit,
		pitch:     pitchInit,
		lastDistT: d,
		fromPiece: fromPiece,
	}
}

// steerToward rotates heading and pitch toward the target at the homing rate,
// then rebuilds velocity from those angles at the current speed.
func (p *projectile) steerToward() {
	dx := p.target.X - p.pos.X
	dy := p.target.Y - p.pos.Y
	dz := p.target.Z - p.pos.Z
	horizD := fixed.Hypot(dx, dz)
	wantHeading := p.heading
	if horizD > fixed.FromFloat(0.001) {
		wantHeading = fixed.Atan2(dx, dz)
	}
	wantPitch := fixed.Atan2(dy, horizD)

	rate := p.turnAng
	if rate <= 0 {
		rate = halfTurn
	}
	step := int32(perTick(fixed.FromInt(int(rate))).Int())
	if step < 1 {
		step = 1
	}

	dh := fixed.ShortestArc(wantHeading - p.heading)
	if dh > step {
		dh = step
	} else if dh < -step {
		dh = -step
	}
	p.heading = fixed.NormalizeAngle(p.heading + dh)

	dp := fixed.ShortestArc(wantPitch - p.pitch)
	if dp > step {
		dp = step
	} else if dp < -step {
		dp = -step
	}
	p.pitch = fixed.NormalizeAngle(p.pitch + dp)

	p.vel = velFromAngles(p.heading, p.pitch, p.speed)
}

// stepProjectile advances one projectile by a single tick. groundY is the floor
// for falling modes. It mutates the projectile and sets dead (and hit, when it
// reached the target rather than expiring).
func (p *projectile) stepProjectile(groundY fixed.Fixed) {
	if p.dead {
		return
	}
	p.ageSec += perTick(fixed.One)

	// Ramp toward top speed under acceleration (instant when accel = 0).
	if p.accel > 0 {
		p.speed = fixed.Min(p.vmax, p.speed+perTick(p.accel))
	} else {
		p.speed = p.vmax
	}

	steered := p.mode == projGuided || (p.mode == projVLaunch && p.phase == phaseHome)
	switch {
	case steered:
		p.steerToward()
	case p.mode == projVLaunch && p.phase == phaseAscent:
		// Climb straight up, pitch over once there is room to arc toward the
		// target without diving into the ground — "room" is the homing turn
		// radius (speed / turnRate), fully derived from the TDF.
		p.vel = fixed.Vec3{Y: p.speed}
		if (p.pos.Y-p.launchY) >= p.homingR || (p.turnAng <= 0 && p.speed >= p.vmax) {
			p.phase = phaseHome
		}
	case p.mode == projDropped || p.mode == projBallistic:
		p.vel.Y = fixed.Wrap32(p.vel.Y - perTick(p.gravity)) // unpowered: gravity bends the path
	default:
		// Straight powered shot — rescale the heading vector to the ramped speed.
		s := hypot3(p.vel.X, p.vel.Y, p.vel.Z)
		if s <= 0 {
			s = fixed.One
		}
		p.vel.X = p.vel.X.Mul(p.speed).Div(s)
		p.vel.Y = p.vel.Y.Mul(p.speed).Div(s)
		p.vel.Z = p.vel.Z.Mul(p.speed).Div(s)
	}

	p.pos.X = fixed.Wrap32(p.pos.X + perTick(p.vel.X))
	p.pos.Y = fixed.Wrap32(p.pos.Y + perTick(p.vel.Y))
	p.pos.Z = fixed.Wrap32(p.pos.Z + perTick(p.vel.Z))

	// Unsteered modes derive orientation from velocity; the steered modes wrote
	// it directly above and re-deriving would re-introduce singularity noise.
	if !steered {
		horiz := fixed.Hypot(p.vel.X, p.vel.Z)
		if horiz > fixed.One {
			p.heading = fixed.Atan2(p.vel.X, p.vel.Z)
		}
		p.pitch = fixed.Atan2(p.vel.Y, horiz)
	}

	// Detonation is pure physics; the blast radius is for damage, not the
	// trigger. Reached the target within one tick's travel (so a fast shot
	// registers the pass instead of tunnelling), hit the ground while falling,
	// or ran out its flight time.
	distT := hypot3(p.target.X-p.pos.X, p.target.Y-p.pos.Y, p.target.Z-p.pos.Z)
	reach := perTick(p.speed)
	// A guided shot turns on a radius far wider than one tick's travel, so a
	// pinpoint "within reach" capture lets it sail past and orbit the target
	// forever. Let it detonate anywhere inside its own blast radius instead.
	prox := reach
	closestPass := false
	if steered {
		prox = fixed.Max(reach, p.aoe.Div(fixed.FromInt(2)))
		// Proximity fuze: once the missile has begun closing, the first tick it
		// starts receding again is its closest pass. Detonate there if it's
		// within a homing-radius of the target — a missile that can't turn
		// tighter than homingR can never do better than that pass. Targets
		// beyond reach keep timing out via lifeSec instead of self-destructing.
		if p.closing && distT > p.lastDistT && distT <= p.homingR {
			closestPass = true
		}
		if distT < p.lastDistT {
			p.closing = true
		}
		p.lastDistT = distT
	}
	switch {
	case distT <= prox || closestPass:
		// Within one tick's travel the shot would pass through the target
		// mid-tick, so land the detonation ON the aim point rather than up to
		// a tick early — a fast shot whose per-tick travel exceeds its blast
		// radius (the EMG: 7.5 wu/tick vs a 4 wu radius) would otherwise
		// detonate short and never damage the very unit it was aimed at. The
		// steered closest-pass fuze keeps its true position: that pass is the
		// physical best a wide-turning missile can do.
		if !closestPass {
			p.pos = p.target
		}
		p.dead = true
		p.hit = true
	case (p.mode == projDropped || p.mode == projBallistic) && p.pos.Y <= groundY:
		p.pos.Y = groundY
		p.dead = true
		p.hit = true
	case p.ageSec >= p.lifeSec:
		p.dead = true
	}
}
