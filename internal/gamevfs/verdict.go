package gamevfs

import (
	"fmt"

	"github.com/coreprime/kbot-io/formats/hpi"
)

// MountVerdict summarises whether TA 3.1c would mount an archive file.
type MountVerdict struct {
	// Mountable is true when the game would mount the archive: a version 1
	// archive ending with the Cavedog copyright trailer whose directory
	// reads.
	Mountable bool `json:"mountable"`
	// Reason says why not; empty when Mountable.
	Reason string `json:"reason,omitempty"`
	// Line is the one-line summary: "TA 3.1c would mount: yes" or
	// "TA 3.1c would mount: no, <reason>".
	Line string `json:"line"`

	// HeaderKey is the key byte of a version 1 header; EffectiveKey the XOR
	// key the game derives from it (0 when not encrypted: header key 0 or
	// 0xFF).
	HeaderKey    uint8 `json:"header_key"`
	EffectiveKey uint8 `json:"effective_key"`
	Encrypted    bool  `json:"encrypted"`
	// TrailerValid reports whether the last 36 bytes are a Cavedog
	// copyright trailer; TrailerYear holds its four year characters.
	TrailerValid bool   `json:"trailer_valid"`
	TrailerYear  string `json:"trailer_year,omitempty"`
}

// Verdict turns kbot-io's validation of an archive into a MountVerdict.
func Verdict(v *hpi.Validation) MountVerdict {
	if v == nil {
		return MountVerdict{Reason: "not validated", Line: "TA 3.1c would mount: no, not validated"}
	}
	out := MountVerdict{
		Mountable:    v.GameMountable,
		HeaderKey:    v.HeaderKey,
		EffectiveKey: v.EffectiveKey,
		Encrypted:    v.Encrypted,
		TrailerValid: v.TrailerValid,
		TrailerYear:  v.TrailerYear,
	}
	if v.GameMountable {
		out.Line = "TA 3.1c would mount: yes"
		return out
	}
	out.Reason = v.Problem.String()
	switch v.Problem {
	case hpi.MountBadVersion:
		if v.Version == hpi.VersionV2 {
			out.Reason = "TA: Kingdoms (version 2) archive; TA 3.1c reads version 1 archives only"
		} else {
			out.Reason = fmt.Sprintf("version 0x%X; TA 3.1c reads version 1 archives only", v.Version)
		}
	case hpi.MountNoTrailer:
		out.Reason = `the file does not end with the 36-byte "Copyright ____ Cavedog Entertainment" trailer`
	case hpi.MountBadDirectory:
		if v.Detail != "" {
			out.Reason += ": " + v.Detail
		}
	}
	out.Line = "TA 3.1c would mount: no, " + out.Reason
	return out
}

// ValidateFile validates the archive at path the way TA 3.1c does before
// mounting it and returns the verdict.
func ValidateFile(path string) (MountVerdict, error) {
	v, err := hpi.Validate(path)
	if err != nil {
		return MountVerdict{}, err
	}
	return Verdict(v), nil
}

// KeyNote describes a version 1 header key byte in the game's terms, such
// as "0x7D (XOR key 0xF5)" or "0xFF (not encrypted)".
func (m MountVerdict) KeyNote() string {
	if !m.Encrypted {
		return fmt.Sprintf("0x%02X (not encrypted)", m.HeaderKey)
	}
	return fmt.Sprintf("0x%02X (XOR key 0x%02X)", m.HeaderKey, m.EffectiveKey)
}
