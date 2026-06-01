// Package wire defines the client/server protocol the websocket transport
// carries. Encoding is JSON: it keeps kbot free of codegen tooling and is the
// path of least resistance for the browser client. The shapes are deliberately
// small — in steady state only orders and command frames flow; snapshots and
// hashes are the periodic authoritative backstop.
package wire

import (
	"encoding/json"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
)

// MsgType tags a message so the receiver knows which payload field is set.
type MsgType string

const (
	MsgJoin        MsgType = "join"
	MsgJoinAccept  MsgType = "join_accept"
	MsgOrder       MsgType = "order"
	MsgCommand     MsgType = "command"
	MsgSnapshot    MsgType = "snapshot"
	MsgHash        MsgType = "hash"
	MsgAck         MsgType = "ack"
	// MsgLeave lets a client relinquish its slot without dropping the socket,
	// so the authority can free the seat and reap an emptied match promptly
	// rather than waiting for the transport to notice the disconnect.
	MsgLeave MsgType = "leave"
	// MsgControl carries sandbox runtime commands (pause / resume / single-step /
	// tick-rate change) both ways: a client requests one, the authority applies
	// it to the shared simulation clock and echoes the resulting state to every
	// client so all windows pause, step and slow together. It is a developer /
	// sandbox affordance, not a competitive-play control.
	MsgControl MsgType = "control"
	// MsgPing / MsgPong are a lightweight round-trip latency probe. The client
	// sends a Ping carrying an opaque sequence number; the authority answers
	// immediately with a Pong echoing that sequence plus its own wall clock, so
	// the client can both measure RTT and estimate the server's clock offset
	// without disturbing the simulation. Pings are answered off the read path so
	// they never queue behind a simulation tick.
	MsgPing MsgType = "ping"
	MsgPong MsgType = "pong"
	// MsgResync asks the authority to push a fresh full snapshot to the
	// requesting client, used by the sandbox "Force Sync" affordance to discard
	// the client's locally diverged state and re-seed from authority.
	MsgResync MsgType = "resync"
	// MsgDiagnose asks the authority for a full snapshot the client uses for
	// read-only drift inspection. Unlike MsgResync the client does NOT restore
	// from it — the returned Snapshot carries Diagnostic=true so the client routes
	// it to the diff UI instead of re-seeding its local engine.
	MsgDiagnose MsgType = "diagnose"
)

// ClientMsg is anything a client sends to the server.
type ClientMsg struct {
	Type    MsgType      `json:"type"`
	Join    *JoinReq     `json:"join,omitempty"`
	Order   *order.Order `json:"order,omitempty"`
	Ack     *Ack         `json:"ack,omitempty"`
	Control *Control     `json:"control,omitempty"`
	Ping    *Ping        `json:"ping,omitempty"`
}

// ServerMsg is anything the server sends to a client.
type ServerMsg struct {
	Type       MsgType       `json:"type"`
	JoinAccept *JoinAccept   `json:"joinAccept,omitempty"`
	Command    *CommandFrame `json:"command,omitempty"`
	Snapshot   *Snapshot     `json:"snapshot,omitempty"`
	Hash       *HashMsg      `json:"hash,omitempty"`
	Control    *Control      `json:"control,omitempty"`
	Pong       *Pong         `json:"pong,omitempty"`
}

// Ping is a client latency probe. Seq is an opaque counter the client uses to
// match the answering Pong to its send time; the server never interprets it.
type Ping struct {
	Seq uint64 `json:"seq"`
}

// Pong answers a Ping. It echoes the client's Seq so the client can compute RTT
// against the send time it stored, and carries the authority's wall clock in
// Unix milliseconds so the client can estimate the server-clock offset.
type Pong struct {
	Seq        uint64 `json:"seq"`
	ServerTime int64  `json:"serverTime"`
}

// Control is a sandbox runtime command and its echoed result. A client sends
// one with Action set ("pause", "resume", "step", "rate"); the authority
// applies it and broadcasts a Control whose Paused / Rate / Tick describe the
// resulting shared clock state so every client converges on it. Rate is a
// wall-clock pacing multiplier (1 = real time, 0.5 = half speed, 2 = double);
// it changes only how often the fixed-size tick advances, never the per-tick
// simulation content, so determinism is unaffected.
type Control struct {
	Action string  `json:"action,omitempty"`
	Paused bool    `json:"paused"`
	Rate   float64 `json:"rate,omitempty"`
	Tick   uint64  `json:"tick,omitempty"`
}

// JoinReq asks to join a match.
type JoinReq struct {
	MatchID     string `json:"matchId"`
	PlayerToken string `json:"playerToken"`
}

// JoinAccept seeds the client's local engine so it can run in lockstep.
type JoinAccept struct {
	PlayerSlot int    `json:"playerSlot"`
	TickRate   int    `json:"tickRate"`
	InputDelay int    `json:"inputDelay"`
	Seed       uint32 `json:"seed"`
	Tick       uint64 `json:"tick"`
}

// CommandFrame is the authoritative set of orders for a future tick. The client
// applies them at exactly that tick to stay in step with the server.
type CommandFrame struct {
	Tick   uint64        `json:"tick"`
	Orders []order.Order `json:"orders"`
}

// HashMsg is a cheap per-interval state digest for desync detection. The hash
// spans the full uint64 range, which overflows a JavaScript number's 53-bit
// integer precision, so it crosses the wire as a decimal string and the browser
// compares it as text against its own string-encoded hash.
type HashMsg struct {
	Tick uint64 `json:"tick"`
	Hash uint64 `json:"hash,string"`
}

// Ack reports the last tick a client has confirmed, for RTT and flow control.
type Ack struct {
	ConfirmedTick uint64 `json:"confirmedTick"`
}

// UnitSnap is the authoritative per-unit state used to (re)initialize or
// resync a client. It carries the raw fixed-point locostate plus the move
// target so a unit caught mid-move keeps driving identically on the resyncing
// client. Piece animation is re-derived locally, so it is not sent.
type UnitSnap struct {
	ID      uint32      `json:"id"`
	Name    string      `json:"name"`
	Side    int         `json:"side"`
	X       fixed.Fixed `json:"x"`
	Y       fixed.Fixed `json:"y"`
	Z       fixed.Fixed `json:"z"`
	Heading fixed.Fixed `json:"heading"` // raw fractional TA-angle
	Speed   fixed.Fixed `json:"speed"`
	HasMove bool        `json:"hasMove"`
	TX      fixed.Fixed `json:"tx"` // move target X
	TZ      fixed.Fixed `json:"tz"` // move target Z
	Health  fixed.Fixed `json:"health"`
	Dead    bool        `json:"dead"`
	// Combat state so a late joiner re-engages weapons/attacks that were live on
	// the authority, replaying the firing animation instead of snapping to rest.
	HasAttack    bool          `json:"hasAttack,omitempty"`
	AttackTarget uint32        `json:"attackTarget,omitempty"`
	Weapons      [3]WeaponSnap `json:"weapons,omitempty"`
	// Cob carries the unit's full live script VM state so the joiner resumes the
	// authority's exact piece poses (turret aim, mid-recoil) rather than
	// re-deriving them from a Create/StartMoving replay. Only join snapshots carry
	// it; periodic backstop snapshots omit it to avoid a bandwidth spike.
	Cob *frame.CobSnapshot `json:"cob,omitempty"`
}

// WeaponSnap is one weapon slot's standing aim/fire order in a join snapshot.
// LastFireMs carries the slot's last shot time so the joiner inherits the
// authority's reload cadence instead of starting a fresh one.
type WeaponSnap struct {
	HasTarget  bool        `json:"hasTarget,omitempty"`
	TargetUnit uint32      `json:"targetUnit,omitempty"`
	PX         fixed.Fixed `json:"px,omitempty"`
	PY         fixed.Fixed `json:"py,omitempty"`
	PZ         fixed.Fixed `json:"pz,omitempty"`
	Source     string      `json:"source,omitempty"`
	LastFireMs int64       `json:"lastFireMs,omitempty"`
}

// ProjectileSnap is one in-flight model weapon (missile/rocket/bomb) carried in a
// join snapshot so the joiner resumes the authority's live shots verbatim rather
// than starting with an empty sky. Every field stepProjectile reads is included
// so flight (and the damage a shot applies on arrival) continues identically.
type ProjectileSnap struct {
	ID       uint32      `json:"id"`
	OwnerID  uint32      `json:"ownerId"`
	TargetID uint32      `json:"targetId,omitempty"`
	Slot     int         `json:"slot"`
	Mode     uint8       `json:"mode"`
	Phase    uint8       `json:"phase"`
	Model    string      `json:"model"`
	Weapon   string      `json:"weapon"`
	X        fixed.Fixed `json:"x"`
	Y        fixed.Fixed `json:"y"`
	Z        fixed.Fixed `json:"z"`
	VX       fixed.Fixed `json:"vx"`
	VY       fixed.Fixed `json:"vy"`
	VZ       fixed.Fixed `json:"vz"`
	OX       fixed.Fixed `json:"ox"`
	OY       fixed.Fixed `json:"oy"`
	OZ       fixed.Fixed `json:"oz"`
	TX       fixed.Fixed `json:"tx"`
	TY       fixed.Fixed `json:"ty"`
	TZ       fixed.Fixed `json:"tz"`
	LaunchY  fixed.Fixed `json:"launchY"`
	Speed    fixed.Fixed `json:"speed"`
	VMax     fixed.Fixed `json:"vmax"`
	Accel    fixed.Fixed `json:"accel"`
	TurnAng  int32       `json:"turnAng"`
	HomingR  fixed.Fixed `json:"homingR"`
	Gravity  fixed.Fixed `json:"gravity"`
	AoE      fixed.Fixed `json:"aoe"`
	Damage   fixed.Fixed `json:"damage"`
	AgeSec   fixed.Fixed `json:"ageSec"`
	LifeSec  fixed.Fixed `json:"lifeSec"`
	LastDist fixed.Fixed `json:"lastDist"`
	Closing  bool        `json:"closing,omitempty"`
	Heading  int32       `json:"heading"`
	Pitch    int32       `json:"pitch"`
	// FromPiece is the emitter piece index the weapon's query-script returned at
	// launch. The sim spawns from the unit origin (it has no geometry), so the
	// renderer uses this to offset the model to the actual muzzle.
	FromPiece int `json:"fromPiece,omitempty"`
}

// Snapshot is a full authoritative state for join/reconnect/resync. The hash is
// string-encoded for the same JS-precision reason as HashMsg.
type Snapshot struct {
	Tick        uint64           `json:"tick"`
	Hash        uint64           `json:"hash,string"`
	Units       []UnitSnap       `json:"units"`
	Projectiles []ProjectileSnap `json:"projectiles,omitempty"`
	// RuntimeRng is the script RNG's draw position at the snapshot tick. OP_RAND
	// consumes this stream, so a joiner that adopts it keeps script-driven
	// randomness (and the animation it drives) in lockstep with the authority.
	// Only join snapshots carry it.
	RuntimeRng uint32 `json:"runtimeRng,omitempty"`
	// Diagnostic marks a snapshot the client requested for read-only drift
	// inspection (MsgDiagnose). The client must NOT restore its engine from it;
	// it is routed to the network-panel diff UI instead.
	Diagnostic bool `json:"diagnostic,omitempty"`
}

// Encode marshals a server message to JSON bytes.
func (m ServerMsg) Encode() ([]byte, error) { return json.Marshal(m) }

// DecodeClient unmarshals client message bytes.
func DecodeClient(b []byte) (ClientMsg, error) {
	var m ClientMsg
	err := json.Unmarshal(b, &m)
	return m, err
}

// Encode marshals a client message to JSON bytes.
func (m ClientMsg) Encode() ([]byte, error) { return json.Marshal(m) }

// DecodeServer unmarshals server message bytes.
func DecodeServer(b []byte) (ServerMsg, error) {
	var m ServerMsg
	err := json.Unmarshal(b, &m)
	return m, err
}
