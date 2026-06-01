package studio

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// vfsWarmEvent is one progress update emitted while the background cache-warmer
// renders VFS assets. The browser's Files tab subscribes to a stream of these
// to show a warming indicator and refresh thumbnails as they land.
type vfsWarmEvent struct {
	Type      string `json:"type"`      // "start", "progress", "done"
	FileType  string `json:"fileType"`  // "gaf", "pcx", "tnt", "sct", "pal", "fnt", "video"
	FileName  string `json:"fileName"`  // VFS path of the file just processed
	Processed int64  `json:"processed"` // files completed so far
	Total     int64  `json:"total"`     // total cacheable files discovered
	Cached    int64  `json:"cached"`    // representations successfully written
}

// vfsEventHub fans warm-progress events out to every connected websocket
// client. It keeps the most recent event so a tab that connects mid-warm (or
// reconnects) immediately sees current progress instead of waiting for the next
// tick.
type vfsEventHub struct {
	mu      sync.Mutex
	subs    map[chan vfsWarmEvent]struct{}
	last    vfsWarmEvent
	hasLast bool
}

func newVFSEventHub() *vfsEventHub {
	return &vfsEventHub{subs: make(map[chan vfsWarmEvent]struct{})}
}

// subscribe registers a buffered channel for events and returns it alongside a
// snapshot of the last event (if any) so the caller can prime a new client.
func (h *vfsEventHub) subscribe() (chan vfsWarmEvent, vfsWarmEvent, bool) {
	ch := make(chan vfsWarmEvent, 64)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[ch] = struct{}{}
	return ch, h.last, h.hasLast
}

func (h *vfsEventHub) unsubscribe(ch chan vfsWarmEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
}

// publish records the event as the latest and delivers it to every subscriber.
// Slow consumers are skipped rather than blocking the warmer.
func (h *vfsEventHub) publish(evt vfsWarmEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.last = evt
	h.hasLast = true
	for ch := range h.subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

// vfsEvents is the package-level hub. It is created at boot in runStudio; the
// websocket handler and the warmer both reference it.
var vfsEvents = newVFSEventHub()

// registerVFSEvents mounts the warm-progress websocket endpoint.
func registerVFSEvents(mux *http.ServeMux) {
	mux.HandleFunc("/api/vfs/events", handleVFSEvents)
}

// handleVFSEvents upgrades the request to a websocket and streams warm-progress
// events until the client disconnects. It mirrors the game host's heartbeat
// pattern so a vanished tab is detected and its subscription freed.
func handleVFSEvents(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer func() { _ = ws.Close(websocket.StatusNormalClosure, "") }()

	ch, last, hasLast := vfsEvents.subscribe()
	defer vfsEvents.unsubscribe(ch)

	go vfsEventsHeartbeat(ctx, cancel, ws)

	if hasLast {
		if !writeVFSEvent(ctx, ws, last) {
			return
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case evt, ok := <-ch:
			if !ok {
				return
			}
			if !writeVFSEvent(ctx, ws, evt) {
				return
			}
		}
	}
}

func writeVFSEvent(ctx context.Context, ws *websocket.Conn, evt vfsWarmEvent) bool {
	b, err := json.Marshal(evt)
	if err != nil {
		return false
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return ws.Write(wctx, websocket.MessageText, b) == nil
}

func vfsEventsHeartbeat(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pctx, pcancel := context.WithTimeout(ctx, 10*time.Second)
			err := ws.Ping(pctx)
			pcancel()
			if err != nil {
				cancel()
				return
			}
		}
	}
}
