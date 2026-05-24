package studio

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
)

// registerCobAPI wires the /api/studio/cob/{name} endpoint into the
// shared mux.  Kept in its own file alongside models.go so the COB
// surface area stays self-contained for the JS-side runtime.
func registerCobAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/cob/", handleCobScript)
}

// cobScriptJSON is the wire format consumed by the browser-side
// cob-runtime.js.  The Go parser does the COB binary decode + opcode
// disassembly; the JS side just walks the instruction list and runs
// the VM.  Keeping the parser in Go means the JS runtime stays small
// and the heavy bit-twiddling lives in well-tested Go code.
type cobScriptJSON struct {
	Name           string             `json:"name"`            // unit ID (lowercased basename)
	NumStaticVars  uint32             `json:"numStaticVars"`   // total static variable slots
	PieceNames     []string           `json:"pieceNames"`      // index → piece name (lowercase ok)
	ScriptNames    []string           `json:"scriptNames"`     // index → entry-point name
	SoundNames     []string           `json:"soundNames"`      // TAK-only; empty for v4 TA cobs
	Scripts        []cobScriptDef     `json:"scripts"`         // one entry per script (matches ScriptNames index)
	Decompiled     string             `json:"decompiled"`      // full BOS source text — studio uses for side-by-side debug
}

// cobScriptDef carries the disassembled instructions for a single
// entry-point script.  Offsets are byte-relative to the start of the
// script and are referenced by JUMP / JUMP_IF_FALSE operands, so we
// pass them through verbatim instead of converting to PC indices —
// the JS side rebuilds an offset → instruction map on load.
type cobScriptDef struct {
	Name         string            `json:"name"`
	Instructions []cobInstruction  `json:"instructions"`
}

// cobInstruction is one disassembled opcode.  `op` is the raw 32-bit
// opcode value (JS uses this for the switch in the runtime), `name`
// is the mnemonic for debugging, `p1`/`p2` are the inline operands
// (zero when the opcode takes no params).
type cobInstruction struct {
	Offset uint32 `json:"offset"`
	Op     uint32 `json:"op"`
	Name   string `json:"name"`
	P1     int32  `json:"p1,omitempty"`
	P2     int32  `json:"p2,omitempty"`
}

func handleCobScript(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/cob/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing cob name", http.StatusBadRequest)
		return
	}
	// Strip extension if the caller helpfully supplied one - we treat
	// the unit name as the canonical key (matches /api/studio/model/).
	name = strings.ToLower(strings.TrimSuffix(name, ".cob"))
	// TA stores COB scripts in the scripts/ folder named after the
	// unit ID.  Some assets case the filename inconsistently so try a
	// couple of likely locations.
	candidates := []string{
		"scripts/" + name + ".cob",
		"Scripts/" + name + ".cob",
		"scripts/" + strings.ToUpper(name) + ".cob",
	}
	var data []byte
	for _, p := range candidates {
		if b, err := vfs.ReadFile(p); err == nil {
			data = b
			break
		}
	}
	if data == nil {
		// Surface a 404 so the JS client can degrade gracefully -
		// many TA assets ship without a per-unit script, in which
		// case the viewer just shows the static 3DO with no animation.
		http.Error(w, "cob not found", http.StatusNotFound)
		return
	}

	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "parse cob: "+err.Error(), http.StatusInternalServerError)
		return
	}

	out := &cobScriptJSON{
		Name:          name,
		NumStaticVars: cob.NumberOfStaticVars,
		PieceNames:    append([]string{}, cob.PieceNames...),
		ScriptNames:   append([]string{}, cob.ScriptNames...),
		SoundNames:    append([]string{}, cob.SoundNames...),
	}
	out.Scripts = make([]cobScriptDef, 0, len(cob.ScriptNames))
	for i := range cob.ScriptNames {
		insts, derr := cob.Disassemble(i)
		if derr != nil {
			http.Error(w, "disassemble: "+derr.Error(), http.StatusInternalServerError)
			return
		}
		script := cobScriptDef{Name: cob.ScriptNames[i]}
		script.Instructions = make([]cobInstruction, 0, len(insts))
		for _, ins := range insts {
			script.Instructions = append(script.Instructions, cobInstruction{
				Offset: ins.Offset,
				Op:     ins.Opcode,
				Name:   scripting.OpcodeName(ins.Opcode),
				P1:     ins.Operand,
				P2:     ins.Operand2,
			})
		}
		out.Scripts = append(out.Scripts, script)
	}
	// Decompile is best-effort — if the decompiler bails on some
	// exotic instruction sequence the studio still gets the
	// disassembly above, so we DON'T error out the whole response.
	// Surface the error as a comment in the source so the user knows
	// why the right pane is empty.
	//
	// Skip the decompile entirely when ?decompile=0 (or =false /
	// =no) is in the query string.  The studio uses that on the
	// initial model-load fetch so the unit pops onto screen without
	// waiting for the slow decompile pass; the debugger fetches a
	// second time (with decompile=1) the first time it opens.
	wantDecompile := true
	switch strings.ToLower(r.URL.Query().Get("decompile")) {
	case "0", "false", "no", "off":
		wantDecompile = false
	}
	if wantDecompile {
		if dec := decompiler.NewDecompiler(cob); dec != nil {
			if bos, derr := dec.Decompile(); derr == nil {
				out.Decompiled = bos
			} else {
				out.Decompiled = "// decompile failed: " + derr.Error()
			}
		}
	}
	writeJSON(w, out)
}
