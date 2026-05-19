# FNT — 1-bit Bitmap Fonts

> Total Annihilation ships a stable of `.fnt` files for everything from
> the on-screen radio chatter (`comix.fnt`) to the unit briefing screens
> (`armbrief.fnt`). They're tiny, variable-width, **1 bit per pixel**
> bitmap fonts indexed by 8-bit character code — basically a sprite
> sheet with a lookup table.

<p align="center">
  <img src="img/fnt-sheet.png" alt="Glyph sheet for comix.fnt" />
  <br/>
  <em>fonts/comix.fnt rendered as a 16-column sprite sheet by <code>kbot fnt sheet</code></em>
</p>

<p align="center">
  <img src="img/fnt-hello.png" alt='"kbot" rendered in yellow' />
  <br/>
  <em><code>kbot fnt render comix.fnt --text "kbot" --fg "#ffff00" --bg "#000000"</code></em>
</p>

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot fnt info     fonts/comix.fnt                    # one-line summary
> kbot fnt describe fonts/comix.fnt --list             # full metadata + glyph list
> kbot fnt sheet    fonts/comix.fnt -o sheet.png       # all glyphs as a grid
> kbot fnt render   fonts/comix.fnt --text "Commander" --fg "#ffff00" --bg transparent -o caption.png
> kbot fnt dump     fonts/comix.fnt -t ./glyphs        # one PNG per character
> ```
> See the CLI [`kbot fnt` reference](../../README.md#kbot-fnt--bitmap-fonts).
>
> **From Go.** Use [`formats/fnt`](../../formats/fnt/fnt.go):
> ```go
> import "github.com/coreprime/kbot/formats/fnt"
>
> f, _ := os.Open("fonts/comix.fnt")
> defer f.Close()
> font, _ := fnt.LoadFromReader(f)
> fmt.Println(font.Height, "px,", font.GlyphCount(), "glyphs")
> if g := font.Glyphs['A']; g != nil {
>     fmt.Println("A is", g.Width, "px wide")
> }
> ```

---

## On-disk layout

```
┌─ 4-byte header ────────┐
│ uint16  Height         │   shared by every glyph
│ uint16  Flags          │   purpose unknown; treat as opaque
├─ 256 × uint16 offsets ─┤   absolute file offsets; 0 = glyph not defined
├─ Glyph data ───────────┤   for each defined glyph:
│   uint8  Width         │   pixel width (1..128)
│   ⌈Width × Height/8⌉   │   1bpp pixels, MSB-first bit stream
└────────────────────────┘
```

Total header + offset table is `4 + 256 × 2 = 516` bytes. Glyph data
starts immediately after.

| Field | Notes |
|-------|-------|
| `Height` | Pixel height shared by every glyph in the font (typically 8–24). Reject heights > 128. |
| `Flags` | Origin unknown. The kbot reader preserves the value verbatim for round-trip; the renderer ignores it. |
| `Offsets[256]` | Indexed by character code (Windows-1252 / CP-437 codepage). `0` means *no glyph for this character*. Non-zero values are absolute file offsets pointing at the glyph's `Width` byte. |
| Glyph `Width` | 0 (or `>128`) is treated as malformed and skipped by the reader. |

---

## Reading a glyph

The glyph payload is a **continuous bit stream**, MSB-first, packed left-
to-right then top-to-bottom — i.e. row-major scan. The number of bits is
`Width × Height` and the number of stored bytes is `⌈(Width × Height) / 8⌉`.

```python
def read_glyph(file, offset, height):
    file.seek(offset)
    width = file.read(1)[0]
    if width == 0 or width > 128:
        return None
    n_bits  = width * height
    n_bytes = (n_bits + 7) // 8
    bits    = file.read(n_bytes)
    pixels  = []
    for i in range(n_bits):
        bit = (bits[i // 8] >> (7 - (i % 8))) & 1
        pixels.append(bool(bit))
    return Glyph(width, height, pixels)
```

There is no kerning data, no baseline offset, no advance width separate
from `Width` — characters are simply rendered side-by-side with their
declared width. The TA renderer leaves a 1-pixel gap between glyphs;
`kbot fnt render` does the same by default.

> [!NOTE]
> **There is no padding between rows.** Each scan line continues from
> wherever the previous one ended in the same byte. A glyph 5 pixels
> wide and 7 pixels tall uses `⌈35/8⌉ = 5` bytes, with the 5 trailing
> bits ignored.

---

## Worked example — `comix.fnt`

```
$ kbot fnt describe fonts/comix.fnt
Height:        14 px
Flags:         0x0001
Glyphs:        94 / 256 defined
Glyph width:   min=3 max=13 mean=5.9
Ranges:        0x20-0x7D
```

Reading this: it's a 14-pixel-high font covering printable ASCII (space
through `}`). Widths vary from 3 (`i`, `l`) to 13 (`M`, `W`). The 162
undefined slots are mostly non-printable control characters; the rest are
Latin-1 extras that the game doesn't display.

The offset table for the first ten characters of `comix.fnt`:

```
char  offset    width  bytes  meaning
0x20  0x021C    4      7     space
0x21  0x0223    3      5     '!'
0x22  0x0228    5      9     '"'
0x23  0x0231    6     11     '#'
0x24  0x023C    5      9     '$'
...
```

You can dump the same thing with `kbot fnt describe --list`.

---

## Rendering tips

`kbot fnt render` supports:

| Flag | Effect |
|------|--------|
| `--text "..."` | The string to render. Multi-line via embedded `\n`. |
| `--fg #rrggbb[aa]` | Foreground colour. Default: white. |
| `--bg #rrggbb[aa]` &#124; `transparent` | Background. Default: opaque black. |
| `--scale N` | Integer pixel doubling. Useful for high-DPI screenshots. |
| `--target PATH` | Output PNG path. Stdout otherwise. |

Any character not present in the font is rendered as a blank space of
the font's mean width.

---

## Gotchas

> [!WARNING]
> **`Offsets[c] == 0` means "no glyph", not "glyph at offset 0".** Offset
> 0 lands in the middle of the header and is structurally impossible —
> Cavedog reuses the sentinel to mean *undefined*. Always treat zero
> offsets as missing.

- **Bit order is MSB-first** within each byte. LSB-first is the more
  common convention in modern bitmap fonts; don't assume.
- **Bit stream is continuous between rows** — there's no padding to a
  byte boundary at the end of each scan line.
- **`Flags` is unstable.** Different fonts use different values
  (`0x0000`, `0x0001`, `0x0080`) and we don't have a working theory.
  Preserve on write; ignore on read.
- **No metadata about which characters are supported.** You have to
  iterate the offset table to discover the glyph set.

---

## Typical sizes

| Asset | Range observed in Cavedog `fonts/*.fnt` |
|-------|-----------------------------------------|
| File size | 700 B – 4 KB |
| Header + offset table | always 516 bytes |
| Glyph height | 8–24 px |
| Glyph width | 3–13 px |
| Defined glyphs per font | 60–120 (most are printable ASCII only) |
| Per-glyph data | typically 5–30 bytes (1 width byte + packed bits) |

---

## See also

- [PAL](pal.md) — fonts don't carry a palette; the renderer needs you to
  pick a fg/bg colour or use the TA palette manually.
- [Glossary](glossary.md) — *1bpp*, *MSB-first bit stream*.
