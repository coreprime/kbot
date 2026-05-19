# PAL / ALP / LHT / SHD — Palettes and Colour Lookup Tables

> Total Annihilation shipped its entire world in **256 colours**. The
> `.pal` file holds that palette; the `.alp`, `.lht`, and `.shd` files are
> 256 × 4 lookup tables the engine uses to compute shadows and light
> levels without leaving the indexed colour space.
>
> All four formats share an identical on-disk layout: **1024 bytes, no
> header, no version field, no compression**. They differ only in how
> those bytes are interpreted.

<p align="center">
  <img src="img/palette.png" alt="TA palette swatch (256 colours, 24px cells)" />
  <br/>
  <em>palettes/palette.pal — rendered by <code>kbot pal swatch</code></em>
</p>

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot pal info     palettes/palette.pal              # one-liner
> kbot pal describe palettes/palette.pal              # full RGB dump
> kbot pal swatch   palettes/palette.pal -o pal.png --cell 24
>
> # Render an ALP/LHT/SHD lookup as a 256×4 PNG, coloured by the palette
> kbot pal lookup   palettes/palette.alp --palette palettes/palette.pal -o alp.png
>
> # Round-trip to editor-friendly formats
> kbot pal convert  palettes/palette.pal -o palette.gpl                  # GIMP
> kbot pal convert  palettes/palette.pal -o palette.txt --format jasc    # JASC
> ```
> See the CLI [`kbot pal` reference](../../README.md#kbot-pal--palettes--lookup-tables).
>
> **From Go.** Use [`formats/pal`](../../formats/pal/pal.go):
> ```go
> import "github.com/coreprime/kbot/formats/pal"
>
> p, _ := pal.LoadFromFile("palettes/palette.pal")
> fmt.Printf("RGBA[0] = %v (transparent sentinel)\n", p.Colors[0])
> for i, c := range p.Colors {
>     fmt.Printf("%3d  #%02x%02x%02x\n", i, c.R, c.G, c.B)
> }
> ```

---

## On-disk layout (all four files)

```c
typedef struct {
    uint8 R;
    uint8 G;
    uint8 B;
    uint8 A;     // Unused. Cavedog files have this as 0 throughout.
} PALEntry;

PALEntry entries[256];   // 256 × 4 = 1024 bytes, total file size
```

The file is **exactly** 1024 bytes. There is no signature, no version,
nothing. If a file in `palettes/` is exactly 1024 bytes, it's one of
these four.

---

## `.pal` — the canonical TA palette

The bytes `R`, `G`, `B`, `A` per entry literally mean *red*, *green*,
*blue*, *unused*. Index 0 is the engine-wide **transparent sentinel** —
even though `palette.pal` has black (`0, 0, 0`) at index 0, the engine
never draws it; anywhere a palette index of 0 appears it shows through
to whatever's behind.

| Index | TA convention | Notes |
|------:|---------------|-------|
| `0` | Transparent | Painted black in the palette but always treated as alpha=0. |
| `9` | "Magic pink" | Used by editor tooling as a fill colour for transparent regions in PCX/GAF before encoding; not transparent at runtime. |
| `16–95` | Player-colour cycles | The engine swaps these out per side to recolour units. |
| `223–254` | Reserved | Mostly used by team-colour cycles and special effects. |
| `255` | Pure white | Frequently used for laser cores. |

> [!NOTE]
> **The 256 RGB triplets are not arbitrary.** Cavedog hand-tuned the
> palette so that smooth ramps exist for each of the major
> material families (metal, organic, water, sky, lava, …). Replacing
> entries to mod a "new" colour in usually breaks every unit that drew
> from that ramp. See `pal describe`'s output for the ramp groupings.

---

## `.alp` / `.lht` / `.shd` — colour lookup tables

These three files share the palette's 1024-byte shape but **are not RGB
data**. Each one is a **256 × 4 array of palette indices** that map
"current colour + intensity bucket" to "resulting colour":

```c
uint8 lookup[256][4];

// Pseudocode for "apply the LHT at light bucket b to palette index c"
uint8 result_index = lookup[c][b];
```

| File | Purpose | Meaning of the 4 buckets |
|------|---------|--------------------------|
| `.alp` (Alpha) | Translucent shadow blending — used to drop semi-transparent shadows on lit terrain without needing alpha-blending. | 4 levels of attenuation. |
| `.lht` (Light) | Per-tile light level applied to terrain and unit surfaces. | 4 lighting levels (e.g. shadow → direct sun). |
| `.shd` (Shadow) | Shadow rendering for projectiles and units. | Hard-coded shadow steps. |

Practically: the engine never blends colours arithmetically — it does a
table lookup, so the resulting pixel is always a real palette index that
can be drawn through the existing 8bpp pipeline. This is why all the
shadows in TA look like a darker version of the same colour ramp, not
"50% black overlaid": each shaded result is the palette index closest to
that mathematical mix.

> [!IMPORTANT]
> **A lookup table is not a palette.** Rendering a `.alp` with `kbot pal
> describe` will show you garbage RGB values because the bytes are not
> RGB. Use `kbot pal lookup` to see what they actually do — pass the
> companion `.pal` so each lookup cell can be coloured with the palette
> entry it resolves to.

---

## Worked example — `palette.pal`

The first 16 entries of the stock TA palette:

| Idx | Hex | R G B | Role |
|----:|-----|-------|------|
| 0 | `#000000` | 0 0 0 | **Transparent** (drawn black but always alpha=0) |
| 1 | `#800000` | 128 0 0 | Dark red |
| 2 | `#008000` | 0 128 0 | Dark green |
| 3 | `#808000` | 128 128 0 | Olive |
| 4 | `#000080` | 0 0 128 | Dark blue (water shadow) |
| 5 | `#800080` | 128 0 128 | Dark magenta |
| 6 | `#008080` | 0 128 128 | Dark cyan |
| 7 | `#808080` | 128 128 128 | Mid grey |
| 8 | `#C0DCC0` | 192 220 192 | Pale green |
| 9 | `#5454FC` | 84 84 252 | **"Magic pink"** (editor transparency) |
| 10–15 | `#000000` × 6 | 0 0 0 | Reserved padding |

`kbot pal describe palettes/palette.pal` prints the full table with a
`(transparent sentinel)` tag next to index 0 and ramp-group annotations
in the trailing portion.

---

## Worked example — `palette.alp` as a lookup

Rendering the ALP table with the palette as colour source:

<p align="center">
  <img src="img/pal-alp-lookup.png" alt="palette.alp visualised through palette.pal" />
  <br/>
  <em>256 columns × 4 rows. Each column is a source palette index;<br/>
      each row is one of the 4 shadow buckets; cell colour shows the result.</em>
</p>

Reading this: column 80 (mid-grey) gets darker as you scan down the
column, because shadow level 0 keeps it as-is, level 1 maps it onto a
slightly darker grey ramp entry, and so on. The engine never needs to
multiply RGB values — it just reads `lookup[c][b]`.

---

## Converting palettes for editors

`kbot pal convert` understands several editor-friendly output formats:

| Format | Extension | Tool |
|--------|-----------|------|
| Binary TA `.PAL` | `.pal` | The format itself; useful for re-emitting after edits. |
| GIMP Palette | `.gpl` | GIMP, Krita, Inkscape. |
| JASC-PAL (text) | `.pal` / `.txt` (`--format jasc`) | Paint Shop Pro, Aseprite. |
| PNG swatch | `.png` (via `kbot pal swatch`) | Visual reference; not loadable as a palette. |

The reverse direction — importing a `.gpl` or `.pal` (JASC) back into a
binary TA `.pal` — works as long as the source has 256 entries.

> [!NOTE]
> **The TA palette has 13 duplicate RGB triplets.** If your editor
> deduplicates colours on import (some do), you'll lose entries and the
> palette will silently become a 243-entry palette. `kbot pal info`
> reports the duplicate count so you can spot the difference; round-trip
> through `kbot pal convert -o roundtrip.pal` to verify.

---

## Gotchas

> [!WARNING]
> **The 4th byte per entry is not alpha.** It's an unused padding byte
> Cavedog always set to `0x00`. Several open-source palette tools read
> it as alpha, then refuse to render the palette (alpha=0 everywhere ⇒
> all transparent). kbot ignores it on read and emits `0x00` on write.

- **Index 0 is transparent everywhere.** Even though its RGB value is
  `(0,0,0)` and `palette.pal` contains plenty of other blacks, only index
  0 is treated as alpha=0 by the renderer.
- **No magic numbers means weak validation.** The only way to sanity-check
  a `.pal` is to require exactly 1024 bytes and (optionally) that the
  alpha byte is zero in every entry.
- **`.alp` / `.lht` / `.shd` are not interchangeable.** They're tuned for
  different effects; swapping them will produce visibly wrong shadows or
  lighting.
- **TA: Kingdoms uses per-side PCX-embedded palettes**, not the global
  `.pal` workflow. See [PCX](pcx.md) for the carrier-PCX trick.

---

## Typical sizes

| File | Size | Notes |
|------|-----:|-------|
| `palette.pal` / `palette.alp` / `palette.lht` / `palette.shd` | Exactly 1024 bytes | Always the same, by spec. |
| GIMP `.gpl` export | ~5 KB | Text format, much larger than binary. |
| JASC `.pal` (text) export | ~3 KB | Same. |
| `kbot pal swatch` PNG | 1–10 KB | Depends on `--cell` size. |
| Total palette files in stock TA | ~15 files | One canonical `palette.*` set plus a few alt UI palettes. |

---

## See also

- [PCX](pcx.md) — files with embedded palettes (and TA:K's
  palette-carrier convention).
- [GAF](gaf.md) — animations that *use* a palette but don't include one.
- [TNT](tnt.md), [SCT](sct.md) — paletted tile data on disk.
- [Glossary](glossary.md) — *paletted image*, *transparent sentinel*,
  *lookup table*.
