// Selection-hotkey API. TA:Kingdoms ships its keyboard table as a root
// keys.tdf ([CUSTOMKEYS]: key token → command string, e.g. "CTRL_R =
// SelectUnits BALLISTIC"); Total Annihilation hardcoded the equivalent table
// in its executable, with units self-declaring membership through literal
// CTRL_x Category tokens. This endpoint serves whatever keys.tdf the session
// VFS resolves; when the game ships none (TA) it returns 404 and the client
// falls back to the game adapter's built-in default table.
package studio

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/coreprime/kbot/formats/gamedata/common"
	"github.com/coreprime/kbot/formats/tdf"
)

func (sess *Session) registerKeysAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/keys", sess.handleKeys)
}

// handleKeys unmarshals the VFS keys.tdf into the typed common.KeysFile and
// serves the bindings, dropping keys bound to nothing ("LOWER_B =;").
func (sess *Session) handleKeys(w http.ResponseWriter, r *http.Request) {
	data := sess.loadKeysTDF()
	if data == nil {
		http.Error(w, "no keys.tdf in this game's data", http.StatusNotFound)
		return
	}
	var kf common.KeysFile
	if err := tdf.Unmarshal(data, &kf); err != nil {
		http.Error(w, "keys.tdf parse failed", http.StatusInternalServerError)
		return
	}
	if len(kf.CustomKeys) == 0 {
		http.Error(w, "keys.tdf has no [CUSTOMKEYS]", http.StatusNotFound)
		return
	}
	keys := make(map[string]string, len(kf.CustomKeys))
	for k, v := range kf.CustomKeys {
		if v = strings.TrimSpace(v); v != "" {
			keys[strings.ToUpper(strings.TrimSpace(k))] = v
		}
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
