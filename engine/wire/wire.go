// Package wire defines the client/server protocol the websocket transport
// carries. Encoding is JSON: it keeps kbot free of codegen tooling and is the
// path of least resistance for the browser client. The shapes are deliberately
// small — in steady state only orders and command frames flow; snapshots and
// hashes are the periodic authoritative backstop.
package wire

import (
	"encoding/json"

	"github.com/coreprime/kbot/engine/fixed"
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
)

// ClientMsg is anything a client sends to the server.
type ClientMsg struct {
	Type  MsgType      `json:"type"`
	Join  *JoinReq     `json:"join,omitempty"`
	Order *order.Order `json:"order,omitempty"`
	Ack   *Ack         `json:"ack,omitempty"`
}

// ServerMsg is anything the server sends to a client.
type ServerMsg struct {
	Type       MsgType       `json:"type"`
	JoinAccept *JoinAccept   `json:"joinAccept,omitempty"`
	Command    *CommandFrame `json:"command,omitempty"`
	Snapshot   *Snapshot     `json:"snapshot,omitempty"`
	Hash       *HashMsg      `json:"hash,omitempty"`
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
}

// Snapshot is a full authoritative state for join/reconnect/resync. The hash is
// string-encoded for the same JS-precision reason as HashMsg.
type Snapshot struct {
	Tick  uint64     `json:"tick"`
	Hash  uint64     `json:"hash,string"`
	Units []UnitSnap `json:"units"`
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
