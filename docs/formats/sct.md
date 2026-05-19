# SCT — Map Sections

> An `.sct` file is a **reusable chunk of map terrain** — Cavedog's level
> designers stitched dozens of these together in the official map editor
> (TAE) to build the finished `.tnt` maps. Each section bundles its own
> tile graphics, tile grid, per-cell heights, and a thumbnail minimap.
> They are the building blocks; TNTs are the assembled product.

<p align="center">
  <img src="img/sct-image.png" alt="Greenworld coast section rendered as tiles" />
  <br/>
  <em>sections/greenworld/coast/b_n_w02_135.sct rendered by <code>kbot sct image</code></em>
</p>

<p align="center">
  <img src="img/sct-minimap.png" alt="Section minimap" />
  &nbsp;&nbsp;
  <img src="img/sct-heightmap.png" alt="Section heightmap" />
  <br/>
  <em>Embedded minimap (left) and elevation grid (right).</em>
</p>

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot sct info       sections/greenworld/coast/b_n_w02_135.sct
> kbot sct describe   sections/greenworld/coast/b_n_w02_135.sct
> kbot sct image      sections/greenworld/coast/b_n_w02_135.sct -t out.png
> kbot sct minimap    sections/greenworld/coast/b_n_w02_135.sct -t mini.png
> kbot sct heightmap  sections/greenworld/coast/b_n_w02_135.sct -t height.png
> ```
> See the CLI [`kbot sct` reference](../../README.md#kbot-sct--map-sections).
>
> **From Go.** Use [`formats/sct`](../../formats/sct/sct.go):
> ```go
> import "github.com/coreprime/kbot/formats/sct"
>
> f, _ := os.Open("sections/greenworld/coast/b_n_w02_135.sct")
> defer f.Close()
> s, _ := sct.LoadFromReader(f)
> fmt.Printf("%dx%d tiles, %d unique, %d heights\n",
>     s.Header.Width, s.Header.Height, s.Header.NumTiles, len(s.HeightMap))
> ```

---

## On-disk layout

```
┌─ Header (28 B) ──┐  version, pointers, dimensions
├─ Tile pixels ────┤  NumTiles × 1024 bytes (32×32 palette indices)
├─ Section data ───┤  Width × Height × int16 tile indices
├─ Height grid ────┤  (Width × 2) × (Height × 2) × {4 or 8} bytes
└─ Minimap ────────┘  128 × 128 palette indices
```

The pointer fields can target sections in any order, but Cavedog's tooling
emits them in the layout shown above and that's what every third-party
reader assumes.

### Header (28 bytes)

```c
typedef struct {
    uint32 Version;     // 2 or 3 (TA's TAE always emits 3)
    uint32 PtrMinimap;  // → 128×128 minimap
    uint32 NumTiles;    // unique 32×32 tile count
    uint32 PtrTiles;    // → tile pixel block
    uint32 Width;       // section width in tiles
    uint32 Height;      // section height in tiles
    uint32 PtrData;     // → tile-index grid + heights
} SCTHeader;
```

| Field | Notes |
|-------|-------|
| `Version` | `3` for retail TA sections. Some early prototypes use `2` — same layout but height entries are 8 bytes instead of 4. kbot accepts both. |
| `Width`, `Height` | Both expressed in **tiles** (32 px units). For a TAE-compatible section both must be multiples of 4 (i.e. multiples of 128 px). |
| `NumTiles` | Unique tile count. The index grid in the data section refers into this array. |

### Tile pixels

`NumTiles` blocks of `32 × 32 = 1024` bytes each — palette indices into
the TA palette. Identical tiles **are not deduplicated automatically by
the format**, so a poorly-built section may waste space; kbot's `image`
command will warn if a section has unreachable tiles.

### Section data — tile indices + height grid

```c
int16 tileMap[Height][Width];     // Index into the tile pixel array
                                  // (signed; negative values are unused
                                  // in retail content but valid)

struct HeightCell_V3 { uint8 h; int16 always_minus_one; uint8 always_zero; };
struct HeightCell_V2 { uint8 h; int16 always_minus_one; uint8 always_zero;
                       uint32 reserved; };

HeightCell heights[Height * 2][Width * 2];
```

The height grid is **four times denser than the tile grid** — every tile
gets `2 × 2 = 4` height samples at 16-pixel resolution, matching how TNT
attribute cells work. The `always_-1` and `always_0` fields are scratch
metadata from the editor; you can write either value back on round-trip.

### Minimap

`128 × 128` palette indices. The dimensions are fixed regardless of the
section's tile width/height, and the minimap is **stretched** to fit the
section's aspect ratio rather than letterboxed.

---

## Reading order

```python
header = read_struct(SCTHeader)
assert header.Version in (2, 3)

seek(header.PtrTiles)
tiles = [read(1024) for _ in range(header.NumTiles)]

seek(header.PtrData)
tile_map = read_int16_array(header.Width * header.Height)

entry_size = 4 if header.Version == 3 else 8
attrs_w, attrs_h = header.Width * 2, header.Height * 2
heights = [read(entry_size)[0] for _ in range(attrs_w * attrs_h)]

seek(header.PtrMinimap)
minimap = read(128 * 128)
```

---

## Worked example — `b_n_w02_135.sct`

```
$ kbot sct describe sections/greenworld/coast/b_n_w02_135.sct
Version:    3
Section:    4 × 4 tiles  (128 × 128 px)
Tiles:      64 unique
Heights:    8 × 8 cells (height range 50–62)
Minimap:    128 × 128
```

A 4×4 tile section is the smallest TAE will accept (must be multiples
of 128 px). Despite the section having `4 × 4 = 16` placements, it
references 64 unique tiles because each 32×32 cell is itself bounded by
edge transitions that the designer wanted variations of. This is normal —
sections trade storage for blending freedom.

---

## How TNT uses sections

A `.tnt` map's tile pool is the union of every `.sct` the level designer
"painted" into it, deduplicated after the fact by TAE. So when you find
two TNTs share a tile, it almost always came from the same SCT.

The connection is **build-time only**. The runtime engine never opens a
section; it only sees the already-combined TNT. Sections live on disk in
the editor archives (`worlds.hpi`) and the campaign world archives, e.g.
`sections/greenworld/coast/`, `sections/lava/hills/`, etc.

---

## Gotchas

> [!WARNING]
> **`Width × Height` must be a multiple of 4 for TAE to load the section.**
> The format itself doesn't enforce this — you can write a 3×3 tile
> section and kbot will happily render it — but Cavedog's editor will
> reject it with a cryptic "section misaligned" error.

- **`Version == 2` has 8-byte height cells**, not 4. The first byte is
  still the elevation; the remaining 7 bytes are editor scratch you can
  zero on write.
- **The 128×128 minimap is stretched**, not letterboxed, to fit the
  section's aspect ratio. A 4×16 section will look horribly squished in
  the minimap.
- **There's no signature** beyond `Version`. To validate a candidate
  SCT, check that `Version ∈ {2, 3}` and that the four pointer fields
  all fall inside the file.
- **Height ranges are entirely up to the designer.** TAE clamps to 0–255
  but a section can be perfectly flat (single value) or full-range. The
  TNT renderer normalises before display; the SCT does not.

---

## Typical sizes

| Asset | Range observed in Cavedog `sections/**/*.sct` |
|-------|-----------------------------------------------|
| File size | 30 KB – 2 MB |
| Section dimensions (tiles) | 4×4 – 32×32 |
| Unique tiles per section | 30–600 |
| Header overhead | always 28 bytes |
| Minimap (always 128×128 paletted) | 16384 bytes |
| Sections in `worlds.hpi` | ~5000 (across all biomes) |

---

## See also

- [TNT](tnt.md) — the assembled map format that consumes sections.
- [PAL](pal.md) — the palette used to colour both tile pixels and the
  minimap.
- [Glossary](glossary.md) — *tile*, *attribute cell*, *heightmap*.
