package gameserver

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coreprime/kbot/engine/wire"
)

const (
	// heartbeatInterval is how often the server pings an idle client. Browsers
	// answer ping control frames automatically, so this detects a vanished tab
	// or a dropped connection without any application-level cooperation.
	heartbeatInterval = 15 * time.Second
	// heartbeatTimeout is how long a single ping waits for its pong before the
	// connection is judged dead.
	heartbeatTimeout = 10 * time.Second
)

// wsConn adapts a coder/websocket connection to the Conn interface the match
// loop consumes. Each frame is one JSON-encoded protocol message.
type wsConn struct {
	ws  *websocket.Conn
	ctx context.Context
}

func (c *wsConn) Send(msg wire.ServerMsg) error {
	b, err := msg.Encode()
	if err != nil {
		return err
	}
	return c.ws.Write(c.ctx, websocket.MessageText, b)
}

func (c *wsConn) Recv() (wire.ClientMsg, error) {
	_, b, err := c.ws.Read(c.ctx)
	if err != nil {
		return wire.ClientMsg{}, err
	}
	return wire.DecodeClient(b)
}

func (c *wsConn) Close() error {
	return c.ws.Close(websocket.StatusNormalClosure, "")
}

// ServeWS upgrades an HTTP request to a websocket and hands the resulting
// connection to the match. It blocks until the request context is closed so the
// underlying transport stays open for the duration of the read loop.
func (m *Match) ServeWS(w http.ResponseWriter, r *http.Request) {
	// Browser clients are served from the studio origin (a different port), so
	// the default same-origin guard would reject them. A game host is meant to
	// accept connections from any page, so we allow every origin.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	// A cancelable context lets the heartbeat tear down a dead connection: when
	// a ping goes unanswered it cancels, which unblocks the read loop's Recv
	// and triggers the match's unregister/leave path.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	m.AddConn(&wsConn{ws: ws, ctx: ctx})
	go heartbeat(ctx, cancel, ws)
	<-ctx.Done()
	_ = ws.Close(websocket.StatusNormalClosure, "")
}

// heartbeat pings the client on an interval and cancels the connection context
// if a ping is not answered within the timeout, so a client that vanishes
// without a clean close is detected and its slot freed.
func heartbeat(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pctx, pcancel := context.WithTimeout(ctx, heartbeatTimeout)
			err := ws.Ping(pctx)
			pcancel()
			if err != nil {
				cancel()
				return
			}
		}
	}
}
