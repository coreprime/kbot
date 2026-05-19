package explorer

import (
	"strings"
	"testing"
)

func TestRewriteHTMLBaseInjectsBase(t *testing.T) {
	in := []byte(`<html><head><title>readme</title></head><body><img src="logo.png"></body></html>`)
	out := string(rewriteHTMLBase(in, "/raw/docs/"))
	if !strings.Contains(out, `<base href="/raw/docs/">`) {
		t.Errorf("output missing injected base tag: %s", out)
	}
	if !strings.Contains(out, `Content-Security-Policy`) {
		t.Errorf("output missing injected CSP meta: %s", out)
	}
	if !strings.Contains(out, `<img src="logo.png">`) {
		t.Errorf("img tag should be preserved as-is so the browser resolves it against the new base: %s", out)
	}
}

func TestRewriteHTMLBaseStripsExistingBase(t *testing.T) {
	in := []byte(`<html><head><base href="https://example.com/"><title>x</title></head><body></body></html>`)
	out := string(rewriteHTMLBase(in, "/raw/foo/"))
	if strings.Contains(out, `https://example.com`) {
		t.Errorf("existing <base> tag was not stripped: %s", out)
	}
	if !strings.Contains(out, `<base href="/raw/foo/">`) {
		t.Errorf("output missing injected base tag: %s", out)
	}
}

func TestRewriteHTMLBaseHandlesMissingHead(t *testing.T) {
	in := []byte(`<html><body><img src="logo.png"></body></html>`)
	out := string(rewriteHTMLBase(in, "/raw/"))
	// Should still get a <base> somewhere up-front so relative URLs resolve.
	if !strings.Contains(out, `<base href="/raw/">`) {
		t.Errorf("output missing injected base tag: %s", out)
	}
}
