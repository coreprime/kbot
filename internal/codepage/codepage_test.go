package codepage

import "testing"

func TestEncode(t *testing.T) {
	cases := []struct {
		page, in, want string
	}{
		{"", "A€é", "A\x80\xe9"},      // Windows-1252 by default
		{"cp1252", "€", "\x80"},       // not U+20AC mod 256 (0xAC)
		{"CP1252", "中", "?"},          // no byte: '?'
		{"cp437", "é", "\x82"},        // DOS Latin US
		{"cp1251", "Ж", "\xc6"},       // Cyrillic
		{"latin1", "é", "\xe9"},       // alias
		{"raw", "\x80A", "\x80A"},     // bytes pass through
		{"iso-8859-15", "€", "\xa4"},  // Latin-9 euro
		{"cp1250", "ł", "\xb3"},       // Central European
		{"windows-1252", "—", "\x97"}, // em dash
		{"cp850", "ÿ", "\x98"},        // ÿ in code page 850
		{"cp1252", "line\nbreak", "line\nbreak"},
	}
	for _, c := range cases {
		got, err := Encode(c.page, c.in)
		if err != nil {
			t.Errorf("Encode(%q, %q): %v", c.page, c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("Encode(%q, %q) = %q, want %q", c.page, c.in, got, c.want)
		}
	}
	if _, err := Encode("klingon", "x"); err == nil {
		t.Error("unknown code page accepted")
	}
}
