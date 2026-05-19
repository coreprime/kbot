# 3DO — Hierarchical 3D Models

> A `.3do` file is a **tree of 3D objects** — vertices, primitives, and
> texture references arranged in a parent/child hierarchy. Every unit in
> the game, every static map feature with geometry, and every projectile
> with a 3D model uses this format. There is **no animation data** in a
> 3DO; pieces are moved at runtime by the unit's [COB](cob.md) script.

> [!TIP]
> **Try it yourself.**
> ```bash
> # 3DO is not currently surfaced as a kbot CLI subcommand, but it's
> # rendered live by the Asset Explorer:
> kbot mount ~/games/totala --server      # opens the web UI
> # then browse to objects3d/armcom.3do
> ```
> See the CLI [`kbot mount` reference](../../README.md#kbot-mount--asset-explorer).
>
> **From Go.** Use [`formats/objects3d`](../../formats/objects3d/tdo.go):
> ```go
> import "github.com/coreprime/kbot/formats/objects3d"
>
> model, _ := objects3d.LoadFromFile("objects3d/armcom.3do")
> fmt.Println(model.Root.Name, "—",
>     model.TotalVertices(), "verts,",
>     model.TotalPrimitives(), "prims,",
>     "textures:", model.Textures())
> for _, obj := range model.AllObjects {
>     fmt.Printf("  %s (%d verts)\n", obj.Name, len(obj.Vertices))
> }
> ```

---

## Why 3DO is built the way it is

`.3do` was Cavedog's answer to "how do we let scripts animate a unit
without expensive matrix math?" — the answer is **hierarchy + per-piece
transforms**. The unit is a tree of named pieces:

```
armcom (root)
├── pelvis
│   ├── torso
│   │   ├── lupperarm
│   │   │   └── lforearm
│   │   │       └── lhand
│   │   ├── rupperarm  ...
│   │   └── head
│   ├── lthigh
│   │   └── lleg
│   └── rthigh
│       └── rleg
└── ...
```

When the COB script says `turn rupperarm to x-axis <30> speed <60>;`,
the engine rotates exactly that piece — and everything attached below it
(forearm, hand, gun-muzzle) follows automatically. There are no skin
weights and no bones in the modern sense; every piece is a rigid sub-mesh
attached at a fixed offset from its parent.

---

## On-disk layout

Each object is a 52-byte header followed by named-array payloads. The
header carries offsets to its children, siblings, vertices, and
primitives.

```c
typedef struct {
    int32 VersionSignature;      // Always 1
    int32 NumberOfVertexes;
    int32 NumberOfPrimitives;
    int32 OffsetToSelectionPrim; // → primitive used as selection rectangle
                                 //   for the root; -1 for non-root objects
    int32 XFromParent;           // Fixed-point offset from parent piece
    int32 YFromParent;           //   (Y is up; the engine renders Y-up)
    int32 ZFromParent;
    int32 OffsetToObjectName;    // → NUL-terminated piece name string
    int32 Always0;
    int32 OffsetToVertexArray;
    int32 OffsetToPrimitiveArray;
    int32 OffsetToSiblingObject; // 0 = end of sibling chain
    int32 OffsetToChildObject;   // 0 = leaf piece
} Object;
```

A vertex is three `int32` fixed-point components:

```c
typedef struct { int32 X, Y, Z; } Vertex;
```

The fixed-point convention is **whole-number = game world unit; divide
by 65536 for sub-unit precision**. Cavedog units are typically tens to
hundreds of world units across.

A primitive is a face (or a single point, or a line):

```c
typedef struct {
    int32 ColorIndex;              // Palette index for solid-coloured faces
    int32 NumberOfVertexIndexes;   // 1 = point, 2 = line, 3 = tri, 4 = quad
    int32 Always0;
    int32 OffsetToVertexIndexArray; // → uint16[NumberOfVertexIndexes]
    int32 OffsetToTextureName;     // → NUL string, or 0 for untextured
    int32 Unknown1;                // Editor scratch
    int32 Unknown2;                // Editor scratch
    int32 IsColored;               // 0 if textured OR pure transparent;
                                   // !=0 if solid-coloured
} Primitive;
```

The vertex-index array referenced by `OffsetToVertexIndexArray` is a
flat list of `uint16` indices into the **object's local vertex array**
(not a global pool).

---

## Hierarchy traversal

Each object header points at the **first** child and the **next** sibling.
This is the classic "first-child / next-sibling" tree encoding — easy to
write a depth-first walk for:

```python
def walk(file, offset, depth=0):
    obj = read_object(file, offset)
    yield (depth, obj.name)
    if obj.child_offset:
        yield from walk(file, obj.child_offset, depth + 1)
    if obj.sibling_offset:
        yield from walk(file, obj.sibling_offset, depth)
```

The **root** object is at file offset `0` and has `SiblingOffset == 0`.
Every piece name in the COB script must match a piece name in this tree
(case-insensitive); a mismatch will cause the script's animation to
silently no-op.

---

## Texturing

`OffsetToTextureName` points at an ASCII string that names a sequence
in `anims/textures.gaf` (or its TA: Kingdoms equivalent). A few things
to know:

- **There are no UV coordinates.** The engine generates UVs from the
  primitive's vertex order. To "rotate" a texture you re-order the
  vertex indices in the primitive's `VertexIndexArray`. The original
  3do Builder editor exposed this as a "texture orientation" knob.
- **`OffsetToTextureName == 0`** means no texture. If `IsColored != 0`,
  draw the primitive as a flat-shaded fill using `ColorIndex`. If both
  are zero, the primitive is **invisible / transparent** — Cavedog uses
  this for collision-only or pure script-anchor faces.
- **In Cavedog-built files the texture name pool starts at file offset
  `0x34`** (immediately after the root object's header). This is a
  convention, not a format requirement.

> [!IMPORTANT]
> **Untextured primitives use `ColorIndex` only when `IsColored != 0`.**
> The pseudocode for "is this primitive visible?" is:
>
> ```c
> bool visible = (texture_name != "") || (IsColored != 0);
> ```
>
> Getting this wrong is the most common 3DO rendering bug — a model
> with collision-only faces ends up filled with random palette colour.

---

## Worked example — `armsy.3do` (Arm Shipyard)

The original Dark Rain walkthrough used the Arm Shipyard. Reading the
root header gives:

```
00000000 Object
  01 00 00 00      VersionSignature = 1
  C4 00 00 00      VertexCount      = 196 (0xC4)
  6D 00 00 00      PrimitiveCount   = 109 (0x6D)
  00 00 00 00      SelectionPrim    = 0 (= primitive #0)
  00 00 00 00 X    XFromParent  = 0
  00 00 00 00 Y    YFromParent  = 0
  00 00 00 00 Z    ZFromParent  = 0
  E5 1A 00 00      → "base"
  00 00 00 00      Always0
  15 04 00 00      → VertexArray
  45 0D 00 00      → PrimitiveArray
  00 00 00 00      SiblingOffset = 0 (root has no sibling)
  EA 1A 00 00      → child object (turret1)
```

Following the child/sibling chain produces the piece tree:

```
base
├── turret1
│   └── nano1
│       └── beam1
├── turret2
│   └── nano2
│       └── beam2
├── slip
├── light
├── explode
├── explode1
└── explode2
```

Some leaves like `slip` are **single-vertex objects with zero
primitives** — those exist only as **anchor points** for COB scripts
(`emit-sfx from slip;`, `move slip to z-axis [-10] speed [20];`).

---

## Gotchas

> [!WARNING]
> **Y is up, not Z.** Cavedog's tooling and most third-party docs use
> Y for the vertical axis. If you import a 3DO into a Z-up engine
> (Blender, modern Unreal) without swapping axes, every unit lies
> sideways.

- **Vertices are local to the object**, not global. Two objects can have
  identical vertex arrays — that's a sign of mirrored geometry, not
  shared data.
- **The `OffsetToSelectionPrim` field is only meaningful for the root
  object.** Children must set it to `-1` (`0xFFFFFFFF`); some editors
  write `0` here and the game ignores it, but third-party tools that
  validate aggressively will flag the model as broken.
- **`Always0` really is always 0** in observed content. It's been the
  "tell us if you find a counter-example" field since 1998 and nobody
  has.
- **Fixed-point scale is `1 / 65536`** — i.e. the low 16 bits of each
  `int32` coordinate are the fractional part. A vertex written
  `0x00010000` is "1.0 world units".
- **Texture names are case-insensitive but case-preserving.** The engine
  hashes lowercased strings; the file stores whatever case the editor
  produced.
- **TA: Kingdoms uses an evolved variant** with additional per-primitive
  data and a true skinning model. kbot does not currently parse it; the
  iiCompleteDestruction project (see kbot's `CLAUDE.md`) has working
  TA:K mesh code.

---

## Typical sizes

| Asset | Range observed in Cavedog `objects3d/*.3do` |
|-------|---------------------------------------------|
| File size | 400 B – 60 KB |
| Vertices per model | 8 – 1000 (commander: ~250) |
| Primitives per model | 6 – 800 |
| Pieces per model | 1 – 80 (Krogoth) |
| `box.3do` (trivial cube) | 420 B |
| `armcom.3do` (Arm Commander) | ~25 KB |
| `corkrog.3do` (Krogoth) | ~60 KB |
| Per-object header | always 52 bytes |
| Per-primitive header | always 32 bytes |

---

## Appendix — Full hex dissection of `objects3d/box.3do`

`box.3do` is a 420-byte cube — one root object, 8 vertices, 6 quad
faces, 4 different textures, no children. It's small enough to walk
end-to-end and exercises every field in the format.

Full hex dump:

```
00000000: 0100 0000 0800 0000 0600 0000 0400 0000   ← Object header
00000010: 0000 0000 0000 0000 0000 0000 a001 0000      (52 bytes)
00000020: 0000 0000 8000 0000 e000 0000 0000 0000
00000030: 0000 0000 4172 6d56 3362 0041 726d 5633   ← Texture-name pool
00000040: 6300 4172 6d56 3361 0041 726d 5633 6400      "ArmV3b\0..."
00000050: 0100 0200 0000 0300 0200 0600 0400 0000   ← Vertex-index array
00000060: 0600 0200 0100 0500 0500 0100 0300 0700      (uint16 × 24)
00000070: 0000 0400 0700 0300 0600 0500 0700 0400
00000080: 0000 f0ff 0000 0000 0000 f0ff 0000 f0ff   ← Vertex array
00000090: 0080 1f00 0000 1000 0000 f0ff 0080 1f00      (8 × 12 bytes)
000000a0: 0000 f0ff 0000 f0ff 0000 0000 0000 1000
000000b0: 0000 1000 0000 0000 0000 f0ff 0000 1000
000000c0: 0080 1f00 0000 1000 0000 1000 0080 1f00
000000d0: 0000 f0ff 0000 1000 0000 0000 0000 1000
000000e0: 0000 0000 0400 0000 0000 0000 5000 0000   ← Primitive 0
000000f0: 3400 0000 0000 0000 0000 0000 0000 0000      (32 bytes)
00000100: 0000 0000 0400 0000 0000 0000 5800 0000   ← Primitive 1
00000110: 3b00 0000 0000 0000 0000 0000 0000 0000
00000120: 0000 0000 0400 0000 0000 0000 6000 0000   ← Primitive 2
00000130: 4200 0000 0000 0000 0000 0000 0000 0000
00000140: 0000 0000 0400 0000 0000 0000 6800 0000   ← Primitive 3
00000150: 3b00 0000 0000 0000 0000 0000 0000 0000
00000160: 0000 0000 0400 0000 0000 0000 7000 0000   ← Primitive 4
00000170: 3b00 0000 0000 0000 0000 0000 0000 0000
00000180: 0000 0000 0400 0000 0000 0000 7800 0000   ← Primitive 5
00000190: 4900 0000 0000 0000 0000 0000 0000 0000
000001a0: 424f 5800                                  ← "BOX\0"
```

### 1. Root object header (`0x00..0x34`)

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `0x00` | `01 00 00 00` | `VersionSignature` | `1` ✓ |
| `0x04` | `08 00 00 00` | `NumberOfVertexes` | `8` (cube corners) |
| `0x08` | `06 00 00 00` | `NumberOfPrimitives` | `6` (cube faces) |
| `0x0C` | `04 00 00 00` | `OffsetToSelectionPrim` | `4` |
| `0x10` | `00 00 00 00` | `XFromParent` | `0` |
| `0x14` | `00 00 00 00` | `YFromParent` | `0` |
| `0x18` | `00 00 00 00` | `ZFromParent` | `0` |
| `0x1C` | `a0 01 00 00` | `OffsetToObjectName` | `0x1A0` → `"BOX"` |
| `0x20` | `00 00 00 00` | `Always0` | `0` |
| `0x24` | `80 00 00 00` | `OffsetToVertexArray` | `0x80` |
| `0x28` | `e0 00 00 00` | `OffsetToPrimitiveArray` | `0xE0` |
| `0x2C` | `00 00 00 00` | `OffsetToSiblingObject` | `0` (root has no sibling) |
| `0x30` | `00 00 00 00` | `OffsetToChildObject` | `0` (leaf — no children) |

### 2. Texture-name pool (`0x34..0x50`)

Four NUL-terminated strings, packed back-to-back:

| Offset | String |
|-------:|--------|
| `0x34` | `"ArmV3b"` |
| `0x3B` | `"ArmV3c"` |
| `0x42` | `"ArmV3a"` |
| `0x49` | `"ArmV3d"` |

These reference sequences in `anims/textures.gaf` (or in a TA:K palette
sheet). Cavedog's convention puts the texture pool at `0x34` —
immediately after the root header — but the format only requires the
offsets to be valid; the strings can live anywhere.

### 3. Vertex-index array (`0x50..0x80`)

A flat `uint16[24]` block — six runs of four indices, one run per quad
face. Reading two bytes at a time:

| Offset | Indices | Used by primitive |
|-------:|:--------|:------------------|
| `0x50` | `1, 2, 0, 3` | Primitive 0 |
| `0x58` | `2, 6, 4, 0` | Primitive 1 |
| `0x60` | `6, 2, 1, 5` | Primitive 2 |
| `0x68` | `5, 1, 3, 7` | Primitive 3 |
| `0x70` | `0, 4, 7, 3` | Primitive 4 |
| `0x78` | `6, 5, 7, 4` | Primitive 5 |

Each row is "the four corners (in CCW order) of one cube face,"
expressed as indices into the vertex array below.

### 4. Vertex array (`0x80..0xE0`)

Eight vertices × `(int32 X, int32 Y, int32 Z)` = 96 bytes. Reading the
first three with little-endian decode:

| # | Bytes | (X, Y, Z) as signed int32 |
|--:|:------|:--------------------------|
| 0 | `00 00 f0 ff   00 00 00 00   00 00 f0 ff` | (`-0x1000`, `0`, `-0x1000`) |
| 1 | `00 00 f0 ff   00 80 1f 00   00 00 10 00` | (`-0x1000`, `+0x1F8000`, `+0x1000`) |
| 2 | `00 00 f0 ff   00 80 1f 00   00 00 f0 ff` | (`-0x1000`, `+0x1F8000`, `-0x1000`) |
| … | | |

`±0x1000` on X and Z place the corners at ±4096 fixed-point units. Y
sweeps from `0` (base) to `+0x1F8000` (top of the cube). Apply the
1/65536 fixed-point scale and you get a roughly 0.0625-world-unit cube
in X/Z, with Y reaching about 31 world units in height — TA's authoring
tools use a stretched-Y convention for "tall props".

### 5. Primitive array (`0xE0..0x1A0`)

Six primitives × 32 bytes. Reading primitive 0 at `0xE0`:

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `0xE0` | `00 00 00 00` | `ColorIndex` | `0` (ignored — textured) |
| `0xE4` | `04 00 00 00` | `NumberOfVertexIndexes` | `4` (quad) |
| `0xE8` | `00 00 00 00` | `Always0` | `0` |
| `0xEC` | `50 00 00 00` | `OffsetToVertexIndexArray` | `0x50` (the first 4-tuple above) |
| `0xF0` | `34 00 00 00` | `OffsetToTextureName` | `0x34` → `"ArmV3b"` |
| `0xF4` | `00 00 00 00` | `Unknown1` | `0` |
| `0xF8` | `00 00 00 00` | `Unknown2` | `0` |
| `0xFC` | `00 00 00 00` | `IsColored` | `0` (textured) |

Summarising all six primitives:

| # | Offset | VtxIdxArray | TextureName | Texture |
|--:|:-------|:-----------:|:-----------:|---------|
| 0 | `0xE0`  | `0x50` | `0x34` | `ArmV3b` |
| 1 | `0x100` | `0x58` | `0x3B` | `ArmV3c` |
| 2 | `0x120` | `0x60` | `0x42` | `ArmV3a` |
| 3 | `0x140` | `0x68` | `0x3B` | `ArmV3c` |
| 4 | `0x160` | `0x70` | `0x3B` | `ArmV3c` |
| 5 | `0x180` | `0x78` | `0x49` | `ArmV3d` |

Three faces share the `ArmV3c` texture, the other three get unique
ones. Texture reuse is just texture-pool offset reuse — the file does
not deduplicate explicitly.

### 6. Object name (`0x1A0..0x1A4`)

```
424f 5800   →  "BOX\0"
```

Total file size: `0x1A4` = 420 bytes. ✓

### Reading it back with kbot

```bash
# The web UI dissects 3DOs interactively
kbot mount $(kbot ctx path) --server
# → browse to objects3d/box.3do
```

From Go ([`formats/objects3d`](../../formats/objects3d/tdo.go)):

```go
import "github.com/coreprime/kbot/formats/objects3d"

model, _ := objects3d.LoadFromFile("objects3d/box.3do")
fmt.Println(model.Root.Name)                  // BOX
fmt.Println(len(model.Root.Vertices))         // 8
fmt.Println(len(model.Root.Primitives))       // 6
fmt.Println(model.Textures())                 // [ArmV3b ArmV3c ArmV3a ArmV3d]
```

---

## Live examples in the reference catalogue

Units sorted by 3DO complexity (the `Objectname` field in the FBI is
the model's filename without extension — see
[reference-ta/ta-units.md](https://github.com/coreprime/reference-ta/blob/main/ta-units.md)):

- **Trivial** — `BOX` (the walkthrough above; 420 bytes, 8 verts, 6 quads),
  most mines (`ARMMINE1`–`6`, `CORMINE1`–`6`).
- **Single-piece** — `ARMRAD` (radar), `ARMTIDE` (tidal generator) —
  one-object meshes good for studying primitive layout.
- **Bipedal kbots** — `ARMCK`, `ARMHAM`, `ARMPW` — multi-piece
  hierarchies you can compare against the `Walk` script in their COBs.
- **Vehicles with turrets** — `ARMBULL`, `ARMSAM`, `CORREAP` — show
  the `turret1 → barrel1` parent/child pattern.
- **Largest models** — `CORKROG` (Krogoth) and `ARMCOM` (Commander)
  — the most complex `.3do` files in the game.

---

## See also

- [COB](cob.md) — script commands that animate 3DO pieces by name.
- [GAF](gaf.md) — texture pages (`anims/textures.gaf`) referenced by
  3DO primitives.
- [PAL](pal.md) — palette used to colour untextured primitives.
- [FBI](tdf.md) — unit definitions that reference 3DO models by
  `ObjectName` (= 3DO filename without extension).
- [Glossary](glossary.md) — *piece*, *anchor object*, *fixed-point*.
