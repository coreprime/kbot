package gameserver

import (
	"context"
	"net/http"

	"github.com/coder/websocket"
	"github.com/coreprime/kbot/engine/wire"
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
	ctx := r.Context()
	m.AddConn(&wsConn{ws: ws, ctx: ctx})
	<-ctx.Done()
}
