package tdf

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// --- synthetic schema exercising every field category -----------------------

type sInner struct {
	Depth int    `tdf:"depth,omitempty"`
	Note  string `tdf:"note,omitempty"`
}

type sItem struct {
	Key  string `tdf:",name"`
	Cost int    `tdf:"cost,omitempty"`
}

type sSchema struct {
	Key  string `tdf:",name"`
	Size int    `tdf:"size,omitempty"`
}

type sParent struct {
	Name    string            `tdf:",name"`
	Title   string            `tdf:"title,omitempty"`
	Count   int               `tdf:"count,omitempty"`
	Tags    []string          `tdf:"tags,omitempty"`
	Nums    []int             `tdf:"nums,omitempty,delimiter=' '"`
	Inner   *sInner           `tdf:"inner,omitempty"`
	Items   []sItem           `tdf:"item"`
	Schemas []sSchema         `tdf:"schema,repeats=SCHEMACOUNT"`
	Damage  map[string]int    `tdf:"damage,omitempty"`
	Extra   map[string]string `tdf:",remaining"`
	Subs    []Section         `tdf:",sections"`
}

func sample() []sParent {
	return []sParent{
		{
			Name:  "UNIT0",
			Title: "First Unit",
			Count: 3,
			Tags:  []string{"alpha", "beta"},
			Nums:  []int{1, 2, 3},
			Inner: &sInner{Depth: 2, Note: "nested"},
			Items: []sItem{{Key: "ITEM0", Cost: 10}, {Key: "ITEM1", Cost: 20}},
			Schemas: []sSchema{
				{Key: "SCHEMA0", Size: 1},
				{Key: "SCHEMA1", Size: 4},
			},
			Damage: map[string]int{"default": 5, "kbot": 7},
			Extra:  map[string]string{"leftover": "value", "other": "thing"},
		},
		{
			Name:  "UNIT1",
			Count: 0,
			Items: []sItem{{Key: "ITEM0", Cost: 1}},
			// Decode always materialises the ,remaining map, so the original must
			// carry a non-nil (here empty) map for the round-trip to compare equal.
			Extra: map[string]string{},
		},
	}
}

// --- encoder ----------------------------------------------------------------

func TestEncoderMatchesMarshalSlice(t *testing.T) {
	v := sample()
	want, err := Marshal(v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var buf bytes.Buffer
	if err := NewEncoder(&buf).Encode(v); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if !bytes.Equal(want, buf.Bytes()) {
		t.Fatalf("streaming Encode != Marshal\n--- Marshal ---\n%s\n--- Encode ---\n%s", want, buf.Bytes())
	}
}

func TestEncoderMatchesMarshalStruct(t *testing.T) {
	v := sample()[0]
	want, err := Marshal(&v)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var buf bytes.Buffer
	if err := NewEncoder(&buf).Encode(&v); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if !bytes.Equal(want, buf.Bytes()) {
		t.Fatalf("streaming Encode != Marshal\n--- Marshal ---\n%s\n--- Encode ---\n%s", want, buf.Bytes())
	}
}

func TestEncoderEmptySlice(t *testing.T) {
	var buf bytes.Buffer
	if err := NewEncoder(&buf).Encode([]sParent{}); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("expected empty output, got %q", buf.String())
	}
}

func TestEncoderNilPointer(t *testing.T) {
	var p *sParent
	if err := NewEncoder(io.Discard).Encode(p); err == nil {
		t.Fatal("expected error encoding nil pointer")
	}
}

// failWriter errors after allowing limit bytes through, to prove the encoder
// propagates write failures rather than swallowing them.
type failWriter struct {
	limit int
	n     int
}

func (w *failWriter) Write(p []byte) (int, error) {
	w.n += len(p)
	if w.n > w.limit {
		return 0, errors.New("disk full")
	}
	return len(p), nil
}

func TestEncoderPropagatesWriteError(t *testing.T) {
	// bufio buffers internally, so force a tiny buffer by writing a large doc.
	big := make([]sParent, 500)
	for i := range big {
		big[i] = sParent{Name: "U", Title: strings.Repeat("x", 64)}
	}
	err := NewEncoder(&failWriter{limit: 16}).Encode(big)
	if err == nil {
		t.Fatal("expected write error to propagate")
	}
}

// --- decoder ----------------------------------------------------------------

func TestDecoderMatchesUnmarshalSlice(t *testing.T) {
	data, err := Marshal(sample())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var want []sParent
	if err := Unmarshal(data, &want); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	var got []sParent
	if err := NewDecoder(bytes.NewReader(data)).Decode(&got); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("streaming Decode != Unmarshal\nwant %#v\ngot  %#v", want, got)
	}
}

func TestDecoderMatchesUnmarshalStruct(t *testing.T) {
	src := sample()[0]
	data, err := Marshal(&src)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var want sParent
	if err := Unmarshal(data, &want); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	var got sParent
	if err := NewDecoder(bytes.NewReader(data)).Decode(&got); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("streaming Decode != Unmarshal\nwant %#v\ngot  %#v", want, got)
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	v := sample()
	var buf bytes.Buffer
	if err := NewEncoder(&buf).Encode(v); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	var got []sParent
	if err := NewDecoder(&buf).Decode(&got); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !reflect.DeepEqual(v, got) {
		t.Fatalf("round trip mismatch\nwant %#v\ngot  %#v", v, got)
	}
}

func TestDecoderEmptyInput(t *testing.T) {
	var got []sParent
	if err := NewDecoder(strings.NewReader("")).Decode(&got); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no elements, got %d", len(got))
	}
}

func TestDecoderNilPointer(t *testing.T) {
	if err := NewDecoder(strings.NewReader("")).Decode([]sParent{}); err == nil {
		t.Fatal("expected error for non-pointer target")
	}
}

// oneByteReader yields a single byte per Read so the parser is exercised across
// every possible read boundary.
type oneByteReader struct {
	data []byte
	pos  int
}

func (r *oneByteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.pos]
	r.pos++
	return 1, nil
}

func TestDecoderChunkedReader(t *testing.T) {
	data, err := Marshal(sample())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got []sParent
	if err := NewDecoder(&oneByteReader{data: data}).Decode(&got); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	var want []sParent
	if err := Unmarshal(data, &want); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("chunked Decode mismatch\nwant %#v\ngot  %#v", want, got)
	}
}

// errReader emits some valid bytes and then a hard error mid-document.
type errReader struct {
	head []byte
	pos  int
}

func (r *errReader) Read(p []byte) (int, error) {
	if r.pos < len(r.head) {
		n := copy(p, r.head[r.pos:])
		r.pos += n
		return n, nil
	}
	return 0, errors.New("read fault")
}

func TestDecoderPropagatesReadError(t *testing.T) {
	// Open a section but never close it, then fault, so the parser is still
	// reading when the error hits.
	var got []sParent
	err := NewDecoder(&errReader{head: []byte("[UNIT0]\n{\n\tcount=1;\n")}).Decode(&got)
	if err == nil {
		t.Fatal("expected read error to propagate")
	}
}

// --- comment / grammar edge cases via the streaming parser ------------------

func TestDecoderHandlesComments(t *testing.T) {
	src := `
// leading line comment
[UNIT0]   /* inline block */
{
	title=hello; // trailing comment
	count=5; /* mid
	          line block */
	tags=a b; // list
}
`
	var got []sParent
	if err := NewDecoder(strings.NewReader(src)).Decode(&got); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 section, got %d", len(got))
	}
	u := got[0]
	if u.Name != "UNIT0" || u.Title != "hello" || u.Count != 5 {
		t.Fatalf("unexpected decode: %#v", u)
	}
	if !reflect.DeepEqual(u.Tags, []string{"a", "b"}) {
		t.Fatalf("tags: %#v", u.Tags)
	}
}

// streamParse drains every top-level element from the streaming parser, the
// streaming analogue of parseDocument.
func streamParse(t *testing.T, data []byte) []*element {
	t.Helper()
	p := &streamParser{r: &stripReader{r: bufio.NewReader(bytes.NewReader(data))}}
	var out []*element
	for {
		el, err := p.nextTopElement()
		if err != nil {
			t.Fatalf("streamParse: %v", err)
		}
		if el == nil {
			return out
		}
		out = append(out, el)
	}
}

func TestStreamParserMatchesInMemory(t *testing.T) {
	cases := []string{
		"",
		"   \n\t  ",
		"[A]{x=1;}",
		"[A]\n{\n x=1;\n y = two words ;\n}\n",
		"[OUTER]{ [INNER]{ a=1; } b=2; }",
		"[A] // headerless body has no brace\n[B]{c=3;}",
		"key=value;", // top-level field, no section
		"[A]{ path=foo/bar; ratio=1/2; }",
		"[A]{ yardmap=ooo OcO; weird=a=b; }",
		"[A]{ unterminated=value", // EOF mid-value, no ';'
		"[A]{ x=1; ",              // EOF mid-section, no closing brace
		"}}}[A]{x=1;}",            // stray closing braces at top level
		"/* whole file is a comment */",
		"[A]{}\n\n[A]{}", // duplicate sibling sections
	}
	for _, src := range cases {
		want, err := parseDocument([]byte(src))
		if err != nil {
			t.Fatalf("parseDocument(%q): %v", src, err)
		}
		got := streamParse(t, []byte(src))
		if !elementsDeepEqual(want, got) {
			t.Fatalf("parser mismatch for %q\nwant %s\ngot  %s", src, dumpEls(want), dumpEls(got))
		}
	}
}

func TestStreamParserMatchesAllGameFiles(t *testing.T) {
	exts := map[string]bool{".tdf": true, ".fbi": true, ".ota": true, ".gui": true, ".tsf": true}
	for _, env := range []string{"TA_UNPACKED_PATH", "TAK_UNPACKED_PATH"} {
		root := os.Getenv(env)
		if root == "" {
			t.Logf("%s not set; skipping", env)
			continue
		}
		var total, skipped, failed int
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if !exts[strings.ToLower(filepath.Ext(path))] {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			if bytes.IndexByte(data, 0) >= 0 {
				skipped++
				return nil
			}
			total++
			want, err := parseDocument(data)
			if err != nil {
				return nil
			}
			got := streamParse(t, data)
			if !elementsDeepEqual(want, got) {
				failed++
				if failed <= 20 {
					t.Errorf("%s: streaming parse differs from in-memory parse", rel(root, path))
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", root, err)
		}
		t.Logf("%s: %d files checked, %d binary skipped, %d failed", env, total, skipped, failed)
	}
}

// --- small helpers ----------------------------------------------------------

func elementsDeepEqual(a, b []*element) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].key != b[i].key || a[i].value != b[i].value || a[i].section != b[i].section {
			return false
		}
		if !elementsDeepEqual(a[i].children, b[i].children) {
			return false
		}
	}
	return true
}

func dumpEls(els []*element) string {
	var b strings.Builder
	_ = writeElems(&b, els, 0)
	return b.String()
}
