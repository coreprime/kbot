# Glossary

A cross-format reference of the recurring vocabulary in Total
Annihilation modding. Terms link back to the page where they're most
deeply discussed.

---

### Anchor object
A [3DO](3do.md) piece with one vertex and zero primitives. Invisible at
runtime; its purpose is to serve as a named coordinate for
[COB](cob.md) script commands (`emit-sfx from <anchor>;`).

### Archive
A [HPI / UFO / CCX / GP3](hpi.md) file. All four extensions are the
same on-disk format and only differ in load order.

### ARGB4444 / ARGB1555
The two 16-bit pixel encodings used by a truecolor [TAF](taf.md).
ARGB4444 packs 4 bits each of alpha, red, green and blue (16 levels of
soft alpha); ARGB1555 packs a 1-bit alpha plus 5 bits each of RGB (a
hard cutout). A frame's `Format` byte (`4` or `5`) selects which.

### Attribute cell
A 16×16 pixel cell in a [TNT](tnt.md) (or [SCT](sct.md)) map. Each
tile is 32×32 px and so contains 4 attribute cells. Heights, feature
placements, and pathing/build legality are stored per attribute cell.

### Axis
For COB/3DO purposes, a numeric ID identifying one of the three rotation
axes: `0` = X, `1` = Y, `2` = Z. The [COB](cob.md) opcodes for
`MOVE`/`TURN`/`SPIN` take the axis as an inline operand. Y is **up**
in 3DO files.

### BOS
"Basic Object Script" — the C-like source language for unit animation
and behaviour scripts. Compiles to [COB](cob.md). Hand-written by
modders; recovered from COB by `kbot cob decompile`.

### COB
"Cobble" — the stack-based bytecode the engine actually executes. See
[COB / BOS](cob.md).

### Compression chunk
A 64 KiB-decompressed-or-less block inside an [HPI](hpi.md) file. Each
chunk has its own SQSH header, compression method (LZ77 / ZLib / none),
size pair, and optional second-pass XOR scrambling.

### Embedded palette
A [PAL](pal.md) appended to a [PCX](pcx.md) file, immediately after the
RLE pixel data, prefixed by a `0x0C` marker byte. 769 bytes total.

### Feature
A static, non-unit object placed on a [TNT](tnt.md) map: tree, rock,
metal patch, geothermal vent, hydration field, etc. Defined in a
`features/**/*.tdf` file (see [TDF](tdf.md)) and referenced by name from
the TNT.

### Fixed-point
The 3DO model coordinate system. Each `int32` coordinate represents
`value / 65536.0` world-space units. So `0x00010000` = exactly 1 world
unit; `0x00018000` = 1.5 world units.

### Footprint
A unit or feature's grid bounding box, expressed in 16-pixel attribute
cells (`FootprintX` × `FootprintZ`). The engine uses this for build
placement and pathing.

### Game tick
The fundamental time unit. **30 ticks per second.** Most timing fields
in [COB](cob.md) and [GAF](gaf.md) use ticks.

### HPI
"HAPI" archive. See [HPI / UFO / CCX / GP3](hpi.md).

### Layering
The way the engine combines multiple [HPI](hpi.md) archives at boot.
Files in a later-loaded archive shadow files of the same path in
earlier archives. Load order is (lowest to highest priority):
`.hpi` → `.ufo` → `.ccx` → `.gp3`.

### Lookup table
A `.alp`, `.lht`, or `.shd` file. 1024 bytes structured as 256 × 4
**palette indices** (not RGB). The engine indexes into them by current
colour and lighting/shadow bucket; the result is another palette index
that can be drawn through the regular 8bpp pipeline. See [PAL](pal.md).

### LZ77
The sliding-window compression used in [HPI](hpi.md) chunks when
`CompMethod == 1`. 4 KiB window, 2-17 byte matches, LSB-first tag bits.

### Magic pink
Palette index 9 in the canonical TA palette (`#5454FC`). Used by editor
tools as a fill colour for transparent regions in source PCX/GAF files;
at runtime it is treated as opaque. The *engine's* transparent sentinel
is palette index 0, not index 9.

### Object name
The lowercased base name shared by a unit's [3DO](3do.md),
[COB](cob.md), and [PCX](pcx.md) files. Declared in the [FBI](tdf.md)
as the `Objectname` field. Distinct from `UnitName`, which is the
external identifier used by other configs.

### OTA
"Online Total Annihilation" — the metadata sidecar for a [TNT](tnt.md)
map. Plain text in TDF format ([TDF](tdf.md)). Carries mission name,
description, AI brief, start positions, environmental hints.

### Paletted image
A bitmap whose pixel values are 8-bit indices into a separate 256-entry
[PAL](pal.md), rather than direct RGB triples. Every visible asset
shipped with TA is paletted: [PCX](pcx.md), [GAF](gaf.md), [SCT](sct.md),
[TNT](tnt.md) tile pixels, and the embedded minimaps. The notable
exception is TA: Kingdoms' [truecolor](#truecolor) [TAF](taf.md)
animations.

### Piece
A named sub-object in a [3DO](3do.md). [COB](cob.md) scripts manipulate
pieces by name (`turn turret1 to y-axis [90] speed [60];`).

### Schema
A named alternative game-setup inside a [TNT](tnt.md)'s sister
[OTA](tdf.md) file. Different schemas typically host different
start-position layouts for different player counts.

### Sea level
The `SeaLevel` field in a [TNT](tnt.md) header. Any attribute cell
whose `Height` byte is **less than** sea level is treated as underwater.
A `SeaLevel == 0` map has nothing underwater; `SeaLevel == 255` has
everything underwater.

### Section
An [SCT](sct.md) file. The reusable tile chunks Cavedog's TAE editor
stitched together to build the final [TNT](tnt.md) maps.

### Signal mask
A bitmask declared in a [COB](cob.md) script (`set-signal-mask <n>`)
that determines which `signal` messages will preempt the current script
instance. Used to cleanly cancel `Walk`/`Aim`/`Idle` animations when
state changes.

### Side
ARM or CORE in TA; Aramon, Taros, Veruna, or Zhon in TA: Kingdoms.
Declared per-unit in the [FBI](tdf.md) `Side` field; also relevant for
which sided palette a [GAF](gaf.md) animation will render against in
TA: Kingdoms.

### SQSH
The marker (`0x48535153` LE) at the head of each compressed chunk in an
[HPI](hpi.md). Whimsical reference to the chunks being "squashed" data.

### Sub-frame
A nested [GAF](gaf.md) frame. A single visible animation frame can be a
composite of multiple sub-frames blitted in order, each with its own
origin offset and pixel data.

### TAF
A [TA: Kingdoms truecolor animation](taf.md). Reuses the [GAF](gaf.md)
container layout but stores 16-bit [ARGB4444 / ARGB1555](#argb4444--argb1555)
pixels instead of palette indices, so it carries its own colour and
alpha. The `.taf` extension is shared with paletted GAF-style files —
the per-frame format byte tells them apart.

### Tick
See *game tick*.

### Tile
A 32×32-pixel chunk of map graphics. The fundamental display unit for
[TNT](tnt.md) and [SCT](sct.md). The tile grid is indexed in `uint16`,
allowing up to 65,536 unique tiles per map in theory.

### Transparent sentinel
Palette index 0. Always rendered as fully transparent regardless of the
RGB stored at that index. Universal across [PCX](pcx.md), [GAF](gaf.md),
and all paletted bitmaps. Truecolor [TAF](taf.md) frames have no
sentinel — transparency comes from the per-pixel alpha channel instead.

### Truecolor
A bitmap that stores a colour (and alpha) per pixel rather than an index
into a palette. The exception to TA's otherwise universally
[paletted](#paletted-image) art: TA: Kingdoms' [TAF](taf.md) animations
use 16-bit [ARGB4444 / ARGB1555](#argb4444--argb1555) pixels.

### TSF
"TAF Source Format" — the human-readable, brace-delimited text form of a
[TAF](taf.md). The TA: Kingdoms GUI loader reads `.tsf` directly for
menu backgrounds; `kbot taf decompile` emits it and `kbot taf compile`
reads it back. See [TAF / TSF](taf.md).

### Virtual filesystem (VFS)
The merged tree of files the engine (and `kbot mount` / `kbot mcp`) see
after layering every [HPI](hpi.md)-family archive in an install root.
Lets you reference a file like `units/ARMCOM.fbi` without caring whether
it lives in `totala1.hpi`, `ccdata.ccx`, or a flattened directory.

### Void cell
A [TNT](tnt.md) attribute cell with `Feature == 0xFFFC`. Marks
impassable terrain (canyon walls, deep water boundaries) that is not
itself a feature but should be treated as if one were there.

### Yardmap
A multi-line ASCII grid in a [FBI](tdf.md) describing per-cell
restrictions for a building's footprint. Common letters: `o` = open
land, `c` = closed (built-on), `w` = water-only.
