# GAF — Graphics Animation Format

> **GAF** stores indexed-colour sprite **animations**. Almost every animated
> 2D element in Total Annihilation is a GAF: cursors, mouse pointers,
> explosions, unit gadgets, tree sway, weapon icons, lava bubble, the lot.
> TA: Kingdoms reuses the same container under the `.taf` extension for its
> *paletted* animations (palette pulled from a sidecar file). TA:K also
> ships a **truecolor** `.taf` variant that stores 16-bit ARGB pixels
> instead of indices — that one has its own page, [TAF / TSF](taf.md).

<p align="center">
  <img src="img/gaf-cursor.gif" alt="cursormove sequence from cursors.gaf" />
  &nbsp;&nbsp;
  <img src="img/gaf-cursorselect.png" alt="single frame from cursorselect" />
</p>

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot gaf list   anims/cursors.gaf                                      # sequences, frame counts, loop flag
> kbot gaf export anims/cursors.gaf --format gif --sequence 0 --target cursor.gif
> kbot gaf dump   anims/cursors.gaf --target ./cursors                   # one PNG per frame
> ```
> See the CLI [`kbot gaf` reference](../../README.md#kbot-gaf--sprite-animations)
> for every flag.
>
> **From Go.** Use [`formats/gaf`](../../formats/gaf/gaf.go):
> ```go
> import "github.com/coreprime/kbot/formats/gaf"
>
> r, _ := gaf.LoadFromFile("anims/cursors.gaf")
> defer r.Close()
> sequences, _ := r.ReadSequences()
> for _, seq := range sequences {
>     fmt.Println(seq.Name, len(seq.Frames))
> }
> ```

---

## At a glance

```
┌─ Header (12B) ─┐
│ ver  N  pad    │
└────────┬───────┘
         ▼
┌─ Sequence offset table ─┐  N × uint32 absolute offsets
└───┬─────────────────────┘
    ▼
┌─ SequenceHeader (40B) ─┐
│ frameCount, loop word, │
│ +4 word, name[32]      │
└─────────┬──────────────┘
          ▼
┌─ FrameListItem (8B) × frameCount ─┐  ptr + tick duration
└───┬───────────────────────────────┘
    ▼
┌─ FrameInfo (24B) ─┐
│ size, origin,     │
│ transparency,     │
│ compressed?,      │
│ layers, +11 byte  │
│ ptrPixelData      │
└─────┬─────────────┘
      ▼
┌─ Pixel data: raw or run-encoded ─┐
└──────────────────────────────────┘
```

A GAF is a flat array of sequences; each sequence is an array of frames;
each frame is a width × height palette-index bitmap with an origin point
and (optionally) RLE-style transparency runs. Frames can carry
"sub-frames" so that one logical animation step is a composite of several
overlaid layers.

---

## Header (12 bytes)

```c
typedef struct {
    uint32 Version;        // 0x00010100 (or 0 for a handful of stock GAFs)
    uint32 SequenceCount;  // Number of animations in the file
    uint32 Unknown1;       // Always 0
} GAFHeader;
```

| Field | Notes |
|-------|-------|
| `Version` | `0x00010100` for all third-party tooling. **Cavedog's `anims/terrain.gaf` and `anims/vismasks.gaf` ship with `Version == 0`.** The game does not check the word; kbot reads any value (an unfamiliar one is reported as a warning) and writes `0x00010100`. |
| `SequenceCount` | Followed immediately by `SequenceCount × uint32` of absolute file offsets, each pointing at a `SequenceHeader`. The game uses only the low 16 bits, read as a signed value: 1–32767 sequences, none for zero or a negative value. |
| `Unknown1` | Always zero; emit zero on write. |

---

## Sequence (40 bytes)

```c
typedef struct {
    uint16 FrameCount;
    uint16 LoopFlags;      // +2: low byte non-zero = the sequence loops
    uint32 Unknown4;       // +4: not used by the game; stock files store 0
    char   Name[32];       // NUL-padded, case-preserved
} GAFSequence;
```

The game loops a sequence when the low byte of `LoopFlags` is set and
plays it once (then stops on the last frame) when it is 0. **Every stock
sequence stores 1.** kbot keeps both words when it rewrites a file, and
`kbot gaf build` gives a sequence without a `sequence.csv` the stock
value 1.

Followed by `FrameCount × FrameListItem`:

```c
typedef struct {
    uint32 PtrFrameInfo;   // → FrameInfo
    uint32 Duration;       // Game ticks (30 ticks = 1 second); low 16 bits used
} FrameListItem;
```

The game reads only the low 16 bits of `Duration` and shows a frame for
`max(Duration, 1)` ticks of its 30 Hz animation clock.

Sequence names matter — the game looks up animations by name (e.g.
`UnitInfo` references `corpyro_smoke` from the `corpyro.gaf` script).
Treat them as case-insensitive ASCII when matching.

---

## Frame (24-byte info + payload)

```c
typedef struct {
    uint16 Width;
    uint16 Height;
    int16  OriginX;            // Render anchor, may be negative
    int16  OriginY;
    uint8  TransparencyIndex;  // Key: transparent in raw frames
    uint8  Compressed;         // 0 = raw bitmap, non-zero = run-encoded
    uint8  LayerCount;         // +10: 0 = simple frame, >0 = composite of layers
    uint8  Blend;              // +11: set on a layer = drawn translucently
    uint32 Unknown2;           // +12: editor scratch, not used by the game
    uint32 PtrFrameData;       // → pixel bytes OR layer pointer table
    uint32 Unknown3;           // Always 0
} FrameInfo;
```

`OriginX` / `OriginY` describe the anchor point used when blitting the
frame into the world. For an explosion sprite the origin is usually the
centre of the blast; for a cursor it's the hotspot pixel.

### Layered frames

When `LayerCount > 0`, `PtrFrameData` is an array of `LayerCount × uint32`
pointers to **nested `FrameInfo`s**, not pixel data. Each layer is
drawn in array order (back-to-front) with its hotspot on the outer
frame's hotspot. A layer whose `+11` byte is set is drawn through the
translucency table instead of being copied (no stock file sets it).
Byte `+10` and byte `+11` are separate fields: reading them as one 16-bit
count turns a set `+11` byte into 256 layers.

### Pixel data

`TransparencyIndex` is **per-frame**, not file-wide — the cursor GAF, for
instance, uses index 9 (the system-pink) on some frames and index 0 on
others.

#### Uncompressed (`Compressed == 0`)

`Width × Height` bytes, top-down, left-to-right. The game draws every
pixel except those equal to `TransparencyIndex`. Unit textures
(`textures/*.gaf`) and the sight masks (`anims/vismasks.gaf`) are read
as plain pixel arrays, so their frames must be raw; every stock frame
there is.

#### Compressed (`Compressed != 0`) — TA Run-Length Encoding

Pixel data is a sequence of `Height` independent rows. Each row starts
with a `uint16 lineLength` followed by a run-length-encoded byte stream
of exactly `lineLength` bytes. Within that stream, each chunk begins
with a 1-byte **mask** whose low two bits select the chunk kind:

| Mask test | Chunk kind | Length (pixels) | Following bytes |
|-----------|-----------|-----------------|-----------------|
| `mask & 0x01` | Transparent run | `count = mask >> 1` | (none — the pixels are skipped) |
| `mask & 0x02` | Repeat run | `count = (mask >> 2) + 1` | 1 byte — the colour index to repeat |
| neither | Literal copy | `count = (mask >> 2) + 1` | `count` bytes — the literal pixels |

So the maximum run lengths are 127 transparent pixels, 64 repeat
pixels, and 64 literal pixels per chunk. **Only skipped pixels are
transparent:** a repeated or literal pixel is drawn even when its value
equals `TransparencyIndex`, and palette index 0 is ordinary opaque
black. If the encoded row ends before `Width`, kbot pads it with
transparent pixels and reports it; the game would read on into the
following bytes. Layers may be smaller than the outer frame and are
positioned by their own `OriginX/Y`.

Reference: [`formats/gaf/gaf.go` `readCompressed`](../../formats/gaf/gaf.go)
and [`formats/gaf/writer.go` `compressRow`](../../formats/gaf/writer.go).

> [!IMPORTANT]
> **GAF is palette-less.** The file only stores 8-bit indices. To render
> in colour you need either the global TA palette
> (`palettes/palette.pal`) or, for TA: Kingdoms, a per-asset palette
> that lives outside the GAF. See [TA: Kingdoms palette resolution]
> (#ta-kingdoms--palette-resolution) and [TA: Kingdoms transparency
> quirk](#ta-kingdoms--transparency-quirk) for the TAK-specific machinery.
> `kbot gaf export` defaults to the embedded TA palette and the game's
> transparency rule; both are overridable.

---

## TA: Kingdoms — palette resolution

> [!NOTE]
> **This section is the TA:K-only delta.** TA's renderer always uses
> `palettes/palette.pal`; the GAF byte layout is identical between TA
> and TAK, but TAK swapped a per-asset palette pipeline in.

TA: Kingdoms ships the same `.gaf` (sometimes `.taf`) container as TA
but draws the palette from a per-asset sidecar. The retail TAK install
follows three documented conventions, in priority order:

1. **Same-name `.pcx` adjacent to the `.gaf`.** UI/anim assets ship
   a 1×1 PCX file with the desired palette embedded as the PCX's PLTE
   chunk. `anims/actionbuttons.gaf` is rendered against
   `anims/actionbuttons.pcx`. About 38% of TAK's `anims/*.gaf` files
   carry such a sidecar.
2. **Same-base-name `.pal` in `palettes/`.** Rare; covers a handful
   of stock assets where Cavedog exported a raw 1024-byte palette.
3. **Side-specific palette by filename prefix.** Unit and feature
   GAFs are named with a 3-letter side prefix and use the matching
   side palette:

   | Prefix | Side | Palette file |
   |--------|------|--------------|
   | `ara*` | Aramon | `palettes/aramon.pcx` |
   | `tar*` | Taros | `palettes/taros.pcx` |
   | `ver*` | Veruna | `palettes/veruna.pcx` |
   | `zon*` | Zhon | `palettes/zhon.pcx` |
   | `aid*` | Aiden (Iron Plague) | `palettes/aiden.pcx` |
   | `cre*` | Creon (Iron Plague) | `palettes/creon.pcx` |

If none of those resolve, the resolver falls back to
`palettes/palette.pal` and finally the embedded TA palette — both of
which are byte-identical in retail TAK and to TA's, so for unit/feature
GAFs that don't match a side prefix the colours will be wrong without
an explicit override.

### kbot's resolver

[`internal/palettepick`](../../internal/palettepick/palettepick.go)
implements the chain above. Every entry point that renders a GAF
threads it through:

- **Web explorer.** The `/png/…` and `/apng/…` routes auto-detect by
  default; the GAF viewer surfaces a palette dropdown listing every
  candidate the resolver finds, plus an `auto` entry. Pass
  `?palette=<vfs-path>` to force a specific one (the dropdown does
  this for you).
- **`kbot gaf export` / `kbot gaf dump`.** Pass `--palette
  <path.pcx|path.pal>` to override; otherwise the embedded TA palette
  is used (the CLI doesn't run the VFS resolver because it has no
  VFS context unless you wrap it with `kbot mount`).
- **MCP `gaf_export` tool.** Accepts an optional `palette` argument
  (a path inside the configured `game-data` folder); omitting it runs
  the full resolver.

### Porting a TA GAF to TA: Kingdoms

TA and TAK GAF byte layouts are identical — only the palette source
differs. To port an existing TA `.gaf`:

1. Create a 1×1 paletted PCX with the TA palette embedded.
2. Save it next to the GAF with the same base name (e.g.
   `MyGaf.gaf` + `MyGaf.pcx`).

That's enough for TAK to render it with the original TA colours.

---

## TA: Kingdoms — transparency quirk

> [!NOTE]
> **This section is the TA:K-only delta.** The `TransparencyIndex`
> byte in the [Frame](#frame-24-byte-info--payload) section is
> authoritative for TA's renderer, but TAK's content authors did not
> keep it in sync with the actual pixel data for uncompressed frames.

Many TAK texture-atlas GAFs (everything under `textures/*.gaf` and a
chunk of `anims/*.gaf`) carry an uncompressed frame with the metadata
`TransparencyIndex` reading some constant (typically `9`) that never
appears in the actual pixel data — meanwhile the artist filled the
"transparent" border with a different palette index (frequently `5`).
A literal reading of the metadata renders an opaque coloured background
where TA's renderer would have produced transparency.

TA's renderer never guesses: it uses the stored key for raw frames and
the skip commands for compressed ones. For TAK atlases kbot offers an
opt-in **corner-detect heuristic** (`TransparencyModeHeuristic`, see
`EffectiveTransparencyIndex` in kbot-io's `formats/gaf`), which applies
to raw frames only:

1. If `TransparencyIndex` is present anywhere in the pixel buffer,
   trust the metadata.
2. Otherwise sample the four corners. If all four agree on a value,
   use that value as the effective transparent index. This rescues
   TAK uncompressed frames where the artist drew a uniform border.
3. Otherwise fall back to the on-disk `TransparencyIndex` (which
   preserves rendering for full-bleed textures like `dungwormB1`,
   whose corners are unit pixels — auto-detection correctly declines
   to override).

Compressed and composite frames always use their skipped pixels. The
on-disk byte is never overwritten — round-trip writers see the original
value. A fully opaque TA frame with a uniform border would lose that
border under the heuristic, so TA renders never use it.

### Overriding transparency at render time

`gaf.RenderOptions` exposes these modes:

| Mode | Behaviour | Use case |
|------|-----------|----------|
| `TransparencyModeAuto` / `TransparencyModeMetadata` | The game's rule: a raw frame's key pixels and a compressed frame's skipped pixels are transparent; index 0 is opaque black (the zero value, and the default everywhere in kbot for TA). | Display, dumps, round trips. |
| `TransparencyModeHeuristic` | Corner guess for raw frames (above), the game's rule otherwise. What the studio uses for TA: Kingdoms sprites. | TAK texture atlases. |
| `TransparencyModeNone` | Every pixel is opaque. | Inspecting the key colour. |
| `TransparencyModeIndex` | Use a caller-supplied index. | UI override; debugging. |

Every exported palette entry is opaque except one transparent slot per
export, normally the frame's key. When a frame draws pixels whose value
equals its key (or frames of one animation use each other's keys as
colours), an index no drawn pixel uses becomes the slot instead, so the
image keeps every palette index.

The asset explorer's GAF viewer offers `Default / Game rule / Corner
guess / None` as a dropdown alongside the palette picker, threading the
choice through as `?transparency=game|heuristic|none|<N>` on every
PNG/GIF/APNG request. The default is the game rule for TA and the corner
guess for TA: Kingdoms installs.
The cache key includes the transparency tag, so swapping modes
doesn't serve stale renders.

---

## Worked example — `cursors.gaf`

```
$ kbot gaf list anims/cursors.gaf
GAF: 22 sequence(s), version 0x00010100

#   Name             Frames  Loops  Duration (ticks)  Duration (sec)
─   ────             ──────  ─────  ────────────────  ──────────────
0   cursormove       8       yes    64                2.13
1   cursorgrn        1       yes    10                0.33
2   cursorselect     2       yes    12                0.40
...
```

A typical `cursormove` frame:

```
Width:       32
Height:      32
OriginX:     16        ← hotspot in the middle of the cursor
OriginY:     16
Transparency: 0        ← this frame's key (compressed, so only skips are transparent)
Compressed:  1         ← run-encoded
LayerCount:  0         ← flat (no sub-frames)
```

---

## Building a GAF

`kbot gaf dump` writes a directory layout that `kbot gaf build` reads back:

```
cursors/
├── cursormove/
│   ├── sequence.csv    ← index,name,loop_flags,unknown4
│   ├── frames.csv      ← frame,width,height,origin_x,origin_y,transparency,
│   │                     duration_ticks,duration_sec,storage,blend
│   ├── animated.png    ← preview only; not read back
│   ├── 0.png
│   ├── 1.png
│   └── ...
└── ...
```

```bash
kbot gaf dump  anims/cursors.gaf --target ./cursors
# edit some PNGs / tweak frames.csv or sequence.csv
kbot gaf build ./cursors --target ./cursors-rebuilt.gaf
kbot gaf roundtrip anims/                     # check dump/build keeps what the game reads
```

Frame images are indexed PNGs (or GIFs with `--format gif`) drawn with
the game's rule, so every pixel keeps its palette index and only the
transparent pixels are marked. The build step copies those indices back
and turns transparent pixels into the frame's key; RGBA images are
matched to the nearest palette colour instead, avoiding the key.

- `sequence.csv` restores the sequence order, its exact name, its loop
  word and its +4 word. Without one, the folder name is the sequence
  name and the sequence loops, like every stock sequence.
- `storage` (`raw` or `compressed`) and `blend` (the +11 byte) restore
  each frame's header. Frames without a storage are compressed, except
  that every frame written to `textures/*.gaf` or `anims/vismasks.gaf`
  is raw, because the game reads those as plain pixel arrays.
  `--storage raw|compressed` overrides both.
- Composite (layered) frames are dumped as one flattened image and
  built back as simple frames; `kbot gaf roundtrip` reports how many.
- A frame with no pixels (width or height 0) has no image; its
  `frames.csv` row alone rebuilds it.
- A sub-folder with neither `frames.csv` nor `sequence.csv` is skipped
  with a warning. Any other sub-folder that cannot be built (a missing
  or unreadable image, a bad CSV value) stops the build, so a sequence
  is never silently left out.

> [!NOTE]
> **TA & TA:K GAFs are byte-identical.** The container is identical;
> only the palette pipeline differs. See
> [TA: Kingdoms palette resolution](#ta-kingdoms--palette-resolution)
> above for the full chain and the worked port-a-GAF-to-TAK recipe.

---

## Gotchas

> [!WARNING]
> **A sequence whose loop byte is 0 plays once and stops.** Tools that
> write the +2 word as zero freeze every animated feature they touch.
> kbot keeps the word, and new sequences built by kbot loop.

- **Some sequences ship with frame durations of `0`.** The game shows
  such a frame for one tick, like a duration of 1. Don't "fix" them to
  a default.
- **Compressed pixel rows can be shorter than `Width`.** The game reads
  on into the next bytes as commands; kbot pads the row with transparent
  pixels and reports it. No stock file has such rows.
- **Layer origins are hotspots**: each layer is placed so its origin
  lands on the outer frame's origin.
- **TA: Kingdoms `.taf` comes in two flavours.** kbot reads a *paletted*
  `.taf` as a vanilla GAF, but TA:K also ships **truecolor** `.taf` files
  (16-bit ARGB pixels, no palette). Check the frame format byte to tell
  them apart and see [TAF / TSF](taf.md) for the truecolor variant.
- **`anims/terrain.gaf` and `anims/vismasks.gaf` have `Version == 0`.**
  The game ignores the version word.
- **Frames per sequence are not bounded** — `cursorteleport` has 46 frames.
  Don't assume a fixed cap when sizing buffers.

---

## Typical sizes

| Asset | Range observed in Cavedog GAFs |
|-------|-------------------------------|
| `anims/cursors.gaf` | ~30 KB, 22 sequences, 1–46 frames each |
| Unit gadget (e.g. muzzle flash) | 5–20 KB, 1 sequence, 4–12 frames |
| Explosion (`anims/explosions.gaf` family) | 50–250 KB per file |
| `anims/textures.gaf` (the master tex sheet) | ~12 MB (largest GAF in TA) |
| `anims/terrain.gaf` | ~1.5 MB |
| Per-frame data | Typically <1 KB; large frames (256×256 explosions) reach 10+ KB |

---

## Live examples in the reference catalogue

Notable GAFs in the TA install — extract any with
`kbot hpi extract` then `kbot gaf list` / `kbot gaf export`:

- **`anims/cursors.gaf`** — 22 sequences, each a UI cursor animation.
  Smallest sequences (`cursorgrn`, `cursorred`) are single frames;
  largest (`cursorteleport`) is 46 frames over 460 ticks. Shown in
  the worked-example section above.
- **`anims/textures.gaf`** — ~12 MB, the master tile sheet referenced
  by every 3DO model's `OffsetToTextureName` strings. Browse with
  `kbot gaf list anims/textures.gaf | head`.
- **`anims/explosions.gaf` family** — typical effects GAFs:
  `lasersht.gaf`, `acid.gaf`, `bigexpls.gaf` — each holds multiple
  named blast sequences.
- **`anims/armcom.gaf` / `corcom.gaf`** — per-side commander gadgets
  (selection circle, build laser).
- **`anims/terrain.gaf` + `anims/vismasks.gaf`** — the only stock
  GAFs with `Version == 0` in the header (worth knowing when writing
  a parser).

---

## See also

- [TAF / TSF](taf.md) — TA: Kingdoms' truecolor `.taf` variant built on
  this same container, plus its editable text form.
- [PAL](pal.md) — the colour table needed to render GAF frames.
- [PCX](pcx.md) — how TA:K supplies a palette to a paletted `.taf`.
- [3DO](3do.md) — when a "sprite" is actually a textured 3D model
  (most explosions are GAF; most projectiles are 3DO + GAF muzzle flash).
- [Glossary](glossary.md) — *sub-frame*, *origin*, *tick*.
