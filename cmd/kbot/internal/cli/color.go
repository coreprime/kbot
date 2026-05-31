package cli

import (
	"fmt"
	"image/color"
)

// ParseColor parses an #rrggbb or #rrggbbaa string into an RGBA value. An empty
// string yields dflt; "transparent" or "none" yields a fully transparent
// colour. The leading '#' is optional.
func ParseColor(s string, dflt color.RGBA) (color.RGBA, error) {
	if s == "" {
		return dflt, nil
	}
	if s == "transparent" || s == "none" {
		return color.RGBA{0, 0, 0, 0}, nil
	}
	if len(s) > 0 && s[0] == '#' {
		s = s[1:]
	}
	if len(s) != 6 && len(s) != 8 {
		return dflt, fmt.Errorf("expected #rrggbb or #rrggbbaa, got %q", s)
	}
	var r, g, b uint8
	var a uint8 = 255
	if _, err := fmt.Sscanf(s[0:2], "%02x", &r); err != nil {
		return dflt, err
	}
	if _, err := fmt.Sscanf(s[2:4], "%02x", &g); err != nil {
		return dflt, err
	}
	if _, err := fmt.Sscanf(s[4:6], "%02x", &b); err != nil {
		return dflt, err
	}
	if len(s) == 8 {
		if _, err := fmt.Sscanf(s[6:8], "%02x", &a); err != nil {
			return dflt, err
		}
	}
	return color.RGBA{R: r, G: g, B: b, A: a}, nil
}
