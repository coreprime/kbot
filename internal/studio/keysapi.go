// Selection-hotkey API. TA:Kingdoms ships its keyboard table as a root
// keys.tdf ([CUSTOMKEYS]: key token → command string, e.g. "CTRL_R =
// SelectUnits BALLISTIC"); Total Annihilation hardcoded the equivalent table
// in its executable, with units self-declaring membership through literal
// CTRL_x Category tokens. This endpoint serves whatever keys.tdf the session
// VFS resolves; when the game ships none (TA) it returns 404 and the client
// falls back to the game adapter's built-in default table.
package studio

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/coreprime/kbot/formats/tdf"
)

func (sess *Session) registerKeysAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/keys", sess.handleKeys)
}

// handleKeys parses the VFS keys.tdf [CUSTOMKEYS] section into a flat
// key-token → command map. Empty bindings ("LOWER_B =;") are dropped.
func (sess *Session) handleKeys(w http.ResponseWriter, r *http.Request) {
	data := sess.loadKeysTDF()
	if data == nil {
		http.Error(w, "no keys.tdf in this game's data", http.StatusNotFound)
		return
	}
	doc, err := tdf.Parse(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "keys.tdf parse failed", http.StatusInternalServerError)
		return
	}
	sec := doc.Section("CUSTOMKEYS")
	if sec == nil {
		http.Error(w, "keys.tdf has no [CUSTOMKEYS]", http.StatusNotFound)
		return
	}
	keys := map[string]string{}
	for _, f := range sec.Fields() {
		v := f.Value()
		// Retail values keep their line tails through the parser: strip the
		// inline // comment and the trailing semicolon.
		if i := strings.Index(v, "//"); i >= 0 {
			v = v[:i]
		}
		v = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), ";"))
		if v == "" {
			continue
		}
		keys[strings.ToUpper(strings.TrimSpace(f.Key()))] = v
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
}

// loadKeysTDF resolves keys.tdf from the session VFS, tolerating the
// case/location variants seen in the wild (root keys.tdf is retail TA:K).
func (sess *Session) loadKeysTDF() []byte {
	for _, p := range []string{"keys.tdf", "KEYS.TDF", "gamedata/keys.tdf"} {
		if data, err := sess.vfs.ReadFile(p); err == nil {
			return data
		}
	}
	for _, p := range sess.vfs.List() {
		if strings.EqualFold(basename(p), "keys.tdf") {
			if data, err := sess.vfs.ReadFile(p); err == nil {
				return data
			}
		}
	}
	return nil
}
