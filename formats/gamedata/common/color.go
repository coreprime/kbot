package common

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/tdf"
)

// RGBString is a colour stored in game data as a space-separated "R G B" triple
// (e.g. "160 35 0"). It implements the tdf codec's custom-scalar interface so it
// round-trips as a single key=value rather than a nested section, while exposing
// the components as typed fields.
type RGBString struct {
	R, G, B int
}

// MarshalTDF renders the colour as "R G B".
func (c RGBString) MarshalTDF() (string, error) {
	return fmt.Sprintf("%d %d %d", c.R, c.G, c.B), nil
}

// UnmarshalTDF parses a space-separated "R G B" triple.
func (c *RGBString) UnmarshalTDF(s string) error {
	parts := strings.Fields(s)
	if len(parts) != 3 {
		return fmt.Errorf("RGBString %q: want 3 components, got %d", s, len(parts))
	}
	vals := [3]int{}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return fmt.Errorf("RGBString %q: %w", s, err)
		}
		vals[i] = n
	}
	c.R, c.G, c.B = vals[0], vals[1], vals[2]
	return nil
}

var (
	_ tdf.ScalarMarshaler   = RGBString{}
	_ tdf.ScalarUnmarshaler = (*RGBString)(nil)
)
