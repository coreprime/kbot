# HPI / UFO / CCX / GP3 — HAPI Archive Files

> **HAPI** ("HPI") is the encrypted, compressed container Cavedog used to ship
> every game asset. The same on-disk layout is reused with different
> extensions:
>
> | Extension | Purpose | Behaviour |
> |-----------|---------|-----------|
> | `.hpi` | Base game archives (`totala1.hpi`, `worlds.hpi`) | Loaded first |
> | `.ufo` | Unit/feature add-ons (`AFark.ufo`) | Layered on top of `.hpi` |
> | `.ccx` | Core Contingency expansion (`ccdata.ccx`, `ccmaps.ccx`) | Layered on top of `.ufo` |
> | `.gp3` | TA "Battle Tactics" / patch overlays (`rev31.gp3`) | Layered on top of `.ccx` |
>
> All four are byte-identical formats — only the load order differs. The
> game folds them into a single virtual filesystem at boot, with later
> archives shadowing earlier ones.

> [!IMPORTANT]
> **Two on-disk dialects.** *Total Annihilation* writes **HPI v1**
> (`Version == 0x00010000`), the encrypted multi-chunk layout this page
> documents top-to-bottom. *Total Annihilation: Kingdoms* writes
> **HPI v2** (`Version == 0x00020000`) — a different, simpler layout
> with no XOR cipher and a single SQSH chunk per file or directory
> block. The v2 specifics live in their own section near the bottom of
> this page: [TA: Kingdoms HPI v2](#ta-kingdoms--hpi-v2).

> ### Load-order layering
>
> When the engine resolves a path like `units/ARMCOM.fbi`, it walks
> sources in priority order and takes the first hit. **Physical
> (loose) files in the install root always win** — that's the
> mechanism mods exploit when shipping a file directly on disk
> (e.g. `units/MYUNIT.fbi`) without packing it. Among archives, later
> tiers override earlier ones, so a `.ufo` add-on can shadow a
> base-game `.hpi` file with the same path.
>
> ```text
>    Query: units/ARMCOM.fbi
>
>    priority ↑   physical files in install root        if found → use this
>            │   ┌───────────────────────────────┐
>            │   │ .gp3 (Battle Tactics patches) │     else fall through
>            │   ├───────────────────────────────┤
>            │   │ .ccx (Core Contingency)       │     else fall through
>            │   ├───────────────────────────────┤
>            │   │ .ufo (mod add-ons)            │     else fall through
>            │   ├───────────────────────────────┤
>            │   │ .hpi (base game)              │     else fall through
>            │   └───────────────────────────────┘
>    priority ↓   "not found"
> ```
>
> Within a tier, archives are loaded in **filesystem-listing order** —
> which on Windows is alphabetical, but is not guaranteed. Don't rely
> on `aaa-mymod.ufo` consistently beating `zzz-othermod.ufo`; if two
> mods conflict, the safe answer is to merge them.
>
> The "physical-files-win" rule is why `kbot mount --flatten` produces
> a directory that behaves identically to the layered set: every file
> the engine would have resolved through the archive stack is present
> as a loose file at the same path, so the resolution short-circuits
> at the top of the stack.

---

## At a glance

```
   ┌─── 20-byte header (clear) ───┐ ┌─── encrypted directory ───┐ ┌─── encrypted file chunks ───┐
   │ "HAPI"  version  dirSize ... │ │ tree of names + offsets   │ │ SQSH chunks, ≤64 KiB each   │
   └──────────────────────────────┘ └───────────────────────────┘ └─────────────────────────────┘
                                                                                      ▲
                                                                       trailer (optional):
                                                            "Copyright 1997 Cavedog Entertainment"
```

The flow to read an HPI is:

1. Read the 20-byte header. Verify the `"HAPI"` magic.
2. Derive the per-file XOR key from `DecryptKey`.
3. Decrypt-and-read the directory tree.
4. For each file you want, seek to its compressed chunks, decrypt them,
   then dispatch on `CompMethod` (LZ77, ZLib, or none).

> [!TIP]
> **Inspect any HPI without writing a parser.**
> ```bash
> kbot hpi info  totala1.hpi          # header + counts
> kbot hpi list  totala1.hpi -v       # files, sizes, compression
> kbot hpi list  totala1.hpi -p "*.bos"
> kbot hpi extract totala1.hpi -p "units/ARMCOM.fbi" -t ./out
> ```
> See the CLI [`kbot hpi` reference](../../README.md#kbot-hpi--archive-files)
> for every flag.
>
> **From Go.** Use [`formats/hpi`](../../formats/hpi/hpi.go):
> ```go
> import (
>     "io"
>     "github.com/coreprime/kbot/formats/hpi"
> )
>
> r, _ := hpi.OpenReader("totala1.hpi")
> defer r.Close()
> _ = r.Walk(func(e *hpi.Entry) error {
>     if !e.IsDir { fmt.Println(e.FullPath(), e.Size) }
>     return nil
> })
> rc, _ := r.Open("units/ARMCOM.fbi")
> defer rc.Close()
> data, _ := io.ReadAll(rc)                     // decompressed bytes
> ```

---

## Header (20 bytes, **clear**)

```c
typedef struct {
    uint32 Marker;         // 'HAPI' = 0x49504148, "BANK" if save-game
    uint32 Version;        // Usually 0x00010000
    uint32 DirectorySize;  // Total directory size in bytes (includes header)
    uint32 DecryptKey;     // Seed for the XOR cipher (0 = no encryption)
    uint32 Start;          // File offset of the directory (almost always 0x14)
} HPIHeader;
```

| Field | Notes |
|-------|-------|
| `Marker` | `'HAPI'` little-endian. The `'BANK'` variant is used by save games and is **not** covered here. |
| `Version` | Retail *Total Annihilation* archives use `0x00010000` (v1, this section). *TA: Kingdoms* archives use `0x00020000` (v2); see [TA: Kingdoms HPI v2](#ta-kingdoms--hpi-v2). |
| `DirectorySize` | Includes the 20 header bytes, so the actual directory blob occupies `DirectorySize − Start` bytes starting at `Start`. |
| `DecryptKey` | Pass through the transform below to get the byte used as the XOR key. A value of `0` disables encryption entirely. Cavedog's retail archives use `0xBF`. |
| `Start` | Where the directory begins. Has always been `0x14` in observed files. |

### Deriving the cipher key

```c
key = (DecryptKey << 2) | (DecryptKey >> 6)   // rotate-left by 2 bits
```

Every encrypted byte is then unscrambled with its absolute file position:

```c
plain[i] = cipher[i] ^ (uint8(pos + i) ^ key)
```

where `pos` is the absolute offset of `cipher[0]` in the file. **Yes — the
seed advances with the file position**, so you can't decrypt a buffer in
isolation; you have to know where it came from.

> [!IMPORTANT]
> **If `DecryptKey == 0`, do not apply the cipher at all.** Some custom
> archives (and a handful of community mods) are written with no
> encryption — applying the XOR cipher in that case will scramble what is
> already plaintext.

---

## Directory tree

A directory is a count plus a pointer to its first entry:

```c
typedef struct { uint32 EntryCount; uint32 EntriesOffset; } HPIDir;
```

Each entry is exactly 9 bytes:

```c
typedef struct {
    uint32 NameOffset;    // → NUL-terminated string
    uint32 DataOffset;    // → HPIDir (subdir) or HPIFile (leaf)
    uint8  Flag;          // 1 = subdirectory, 0 = file
} HPIEntry;
```

For files, `DataOffset` points at:

```c
typedef struct {
    uint32 DataOffset;    // Absolute file offset of the first compressed chunk
    uint32 FileSize;      // **Decompressed** size in bytes
    uint8  CompMethod;    // 0 = stored, 1 = LZ77, 2 = ZLib
} HPIFile;
```

All offsets are **absolute** within the file. That's why the canonical
parser allocates a `DirectorySize`-byte buffer and writes the directory at
position `Start` — that way pointers can index the buffer directly without
arithmetic.

### Reading the directory

```python
buf = bytearray(header.DirectorySize)
file.seek(header.Start)
encrypted = file.read(header.DirectorySize - header.Start)
buf[header.Start:] = decrypt(encrypted, key, seed=header.Start)
walk(buf, header.Start)   # recurses on Flag == 1 entries
```

> [!NOTE]
> **Filename casing is preserved on write but matched case-insensitively
> on read.** Total Annihilation grew up on Windows 9x; mods commonly mix
> `armcom.fbi` and `ARMCOM.FBI` even within the same archive. The kbot
> reader is case-insensitive throughout; assume the engine is too.

---

## Compressed chunks (SQSH)

A file's data is sliced into chunks of up to **64 KiB decompressed**. Each
chunk has its own 19-byte header:

```c
typedef struct {
    uint32 Marker;            // 'SQSH' = 0x48535153
    uint8  Version;           // Always 0x02 in observed files
    uint8  CompMethod;        // 1 = LZ77, 2 = ZLib
    uint8  Encrypted;         // 1 = chunk body is XOR-scrambled, 0 = plaintext
    uint32 CompressedSize;    // Length of the encrypted+compressed payload
    uint32 DecompressedSize;  // Length after CompMethod is undone
    uint32 Checksum;          // Sum of the encrypted payload bytes (uint32)
    uint8  data[CompressedSize];
} HPIChunk;
```

The number of chunks is `ceil(FileSize / 65536)`. Immediately after the
file's first `HPIFile.DataOffset` you'll find an array of `uint32`
compressed-sizes, one per chunk, followed by the chunks themselves
back-to-back.

### The second XOR layer

If `Encrypted == 1`, each chunk body has a **second** XOR pass applied:

```c
for (i = 0; i < CompressedSize; i++)
    data[i] = (data[i] - i) ^ i;
```

Note that **the checksum is over the still-encrypted bytes** — verify
before you undo the cipher.

### LZ77 (CompMethod = 1)

A textbook sliding-window LZ77 with a 4 KiB history:

- **Tag byte** — 8 flag bits, LSB-first. `0` ⇒ literal, `1` ⇒ back-reference.
- **Literal** — copy 1 byte verbatim to the output and history.
- **Match** — read a `uint16`. The upper 12 bits are the window offset
  (1–4095), the lower 4 bits encode the length as `len − 2` (so matches are
  2–17 bytes).
- **Terminator** — a match with `windowOffset == 0` ends the stream.

### ZLib (CompMethod = 2)

Standard `zlib` raw stream. Feed the chunk body to `inflate()` after the
encryption layer has been removed; `DecompressedSize` is the expected
length.

### Stored (CompMethod = 0)

Bytes are written verbatim — no chunking, no checksum, no second XOR pass.
Useful for files that don't compress (already-compressed PCX/GAF), and the
only mode the legacy "unit viewer" understands.

---

## Trailer

Retail archives end with the 36-byte ASCII signature:

```
Copyright 1997 Cavedog Entertainment
```

It is not pointed at from anywhere in the header — the game appears to
match it as a sanity check. kbot's writer reproduces it by default; strip
it only if you're deliberately trying to fingerprint a mod-built archive.

---

## TA: Kingdoms — HPI v2

> [!NOTE]
> **This section is the TA:K-only delta.** Everything above applies to
> *Total Annihilation* (`Version == 0x00010000`). *TA: Kingdoms* ships
> the same `.hpi` extension but a different on-disk layout — read this
> section in full before reaching for the v1 parser.

TA: Kingdoms keeps the `'HAPI'` magic and the directory-tree concept but
otherwise overhauls the wrapper. The differences in one breath:

| Aspect | v1 (TA) | v2 (TA: Kingdoms) |
|--------|---------|--------------------|
| Version field | `0x00010000` | `0x00020000` |
| Header size | 20 bytes (5 × uint32) | 32 bytes (8 bytes magic+version + 24-byte sub-header) |
| Encryption | XOR cipher seeded by `DecryptKey`, advances with file position | **None** — everything is plaintext |
| Directory + name pool location | Right after the header (encrypted) | At arbitrary offsets near the tail of the file (typically), each optionally wrapped in a single SQSH chunk |
| Per-file chunking | Sliced into ≤64 KiB chunks with a length table; each chunk has its own SQSH header + checksum + optional second XOR pass | **Single SQSH chunk** with the whole payload, or stored bytes if `CompressedSize == 0`; no XOR pass, no length table |
| Per-chunk cipher (`Encrypted` byte in SQSH) | Used | Not used (we still respect the byte if it's set, but every TAK file we've sampled has it `0`) |

### v2 header

After the 8-byte prologue (`'HAPI'` + `0x00020000`) come **six 32-bit
little-endian fields** — total header on disk is 32 bytes:

```c
// At offset 0 — same as v1.
typedef struct { uint32 Marker; uint32 Version; } HPIPrologue;

// At offset 8 — TA: Kingdoms only.
typedef struct {
    int32 DirectoryBlock;          // Absolute offset of the directory blob
    int32 DirectorySize;           // Length of the directory blob on disk
    int32 NameBlock;               // Absolute offset of the string pool
    int32 NameSize;                // Length of the string pool on disk
    int32 Data;                    // Offset of the first file payload (typically 0x20)
    int32 Last78;                  // 0, or an offset to a trailing 78-byte block
} HPIHeaderV2;
```

The directory blob and name blob both **may** be SQSH-compressed — if
the first four bytes at `DirectoryBlock` / `NameBlock` are `'SQSH'`,
treat the block as a single chunk (header + payload) and decompress it.
If not, the `Size` bytes at the given offset are the raw decompressed
content.

### v2 directory entries

The decompressed directory blob is a packed array of two record types
(no separate offset tables, no `EntryCount` prefix — children are
located via the parent's `FirstSubDirectory` / `FirstFile` pointers):

```c
typedef struct {                   // 20 bytes — HpiDir2
    int32 NamePtr;                 // Offset into NameBlock (NUL-terminated string)
    int32 FirstSubDirectory;       // Byte offset into the directory blob
    int32 SubCount;                // Number of subdirectories
    int32 FirstFile;               // Byte offset into the directory blob
    int32 FileCount;               // Number of files
} HpiDir2;

typedef struct {                   // 24 bytes — HpiEntry2
    int32 NamePtr;                 // Offset into NameBlock
    int32 Start;                   // Absolute file offset of the payload
    int32 DecompressedSize;
    int32 CompressedSize;          // 0 ⇒ payload is stored verbatim, no SQSH wrapper
    int32 Date;                    // time_t when packed (informational)
    int32 Checksum;                // Informational — the SQSH chunk carries its own
} HpiEntry2;
```

### Per-file payloads

For a file entry at offset `Start`:

- If `CompressedSize == 0`: read `DecompressedSize` bytes verbatim.
- Otherwise: the next `CompressedSize` bytes form a **single SQSH
  chunk** (same 19-byte header as v1) — read it, verify its checksum
  against the byte-sum of the payload, decode with the chunk's
  `CompMethod` (`1` = LZ77, `2` = ZLib), and you have the file.

The v1 multi-chunk scheme (size table, ≤64 KiB chunks, encryption pass)
is gone. v2 trades the compactness for a vastly simpler reader.

### kbot's handling

`kbot hpi list`, `extract`, and `info` all transparently support both
dialects — they dispatch on the `Version` word in the header. Round-trip
writing (`kbot hpi pack`) currently emits v1 only; we don't yet author
v2 archives.

The internal v2 reader is in [`formats/hpi/hpi_v2.go`](../../formats/hpi/hpi_v2.go).
`hpi.Reader.Version()` reports whether the file you loaded is v1 or v2.

> [!TIP]
> **Confirm a TAK install loads.**
> ```bash
> kbot hpi list ~/games/takingdoms/data.hpi -v | head
> kbot ctx add ~/games/takingdoms --alias tak --game takingdoms
> kbot mount  # walks every TAK .hpi as a single VFS
> ```

---

## Worked example — `aflakker.ufo`

The original Joe D. walkthrough used the Arm Flakker unit add-on; we'll
reproduce its dissected header here. Hex dump of the first 32 bytes:

```
00000000  48 41 50 49 00 00 01 00 24 02 00 00 7D 00 00 00   HAPI....$...}...
00000010  14 00 00 00 ...                                   ...
```

Field by field:

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `0x00` | `48 41 50 49` | `Marker` | `'HAPI'` ✓ |
| `0x04` | `00 00 01 00` | `Version` | `0x00010000` ✓ |
| `0x08` | `24 02 00 00` | `DirectorySize` | `0x224` = 548 bytes |
| `0x0C` | `7D 00 00 00` | `DecryptKey` | `0x7D` → `key = (0x7D << 2) \| (0x7D >> 6) = 0xF5` |
| `0x10` | `14 00 00 00` | `Start` | `0x14` |

Decrypting `[0x14, 0x224)` and walking the tree yields:

```
.
├── anims/
│   └── armflak_gadget.gaf
├── download/
│   └── ARMFLAK.TDF
├── features/corpses/
│   └── armflak_dead.tdf
├── objects3d/
│   ├── armflak.3do
│   └── armflak_dead.3do
├── scripts/
│   └── ARMFLAK.COB
├── unitpics/
│   └── ARMFLAK.PCX
├── units/
│   └── ARMFLAK.FBI
└── weapons/
    └── armflak_weapon.tdf
```

This nine-file layout is the canonical shape of a single-unit `.ufo`
add-on; the base `totala*.hpi` archives use the same scheme at scale (~30k
files).

> [!TIP]
> **Reproduce this dissection on your own machine.**
> ```bash
> kbot hpi info path/to/aflakker.ufo
> kbot hpi list path/to/aflakker.ufo -v
> kbot hpi extract path/to/aflakker.ufo -t ./aflakker-out
> ```

---

## Repacking

To build a new archive from a directory tree:

```bash
kbot hpi pack ./aflakker-out --target aflakker-new.ufo
```

kbot defaults to **ZLib chunked compression** with the standard `0xBF`
header key and a Cavedog trailer — which produces a binary the retail
engine accepts. If you need byte-identical round-trips against an existing
file (e.g. for modding validation), the per-chunk compression choices are
recorded in `metadata.json`-style sidecars by `kbot mount flatten`.

---

## Gotchas

> [!WARNING]
> **Pointers are absolute to file start, not directory start.** Subtract
> nothing. The standard implementation trick is to allocate a buffer of
> `DirectorySize` bytes and read the decrypted directory into it at offset
> `Start` so the pointers index the buffer directly.

- **Chunk count formula** — `ceil(FileSize / 65536)`. There is **no
  explicit count field**; you have to derive it from `FileSize`.

---

## Typical sizes

| Archive | Size | Files | Notes |
|---------|-----:|------:|-------|
| `totala1.hpi` (sounds, anims) | ~30 MB | ~1900 | Base game, biggest single archive. |
| `totala2.hpi` (units) | ~13 MB | ~600 | Most unit metadata + scripts. |
| `totala4.hpi` (maps) | ~50 MB | ~300 | All retail maps. |
| `worlds.hpi` (sections) | ~20 MB | ~5000 | Editor SCT libraries. |
| `ccdata.ccx` (Core Contingency) | ~25 MB | ~1500 | Expansion units/maps. |
| Typical single-unit `.ufo` | 10–150 KB | 8–12 | Most third-party unit add-ons. |
| Map-only `.ufo` (with `.tnt` + `.ota`) | 0.5–5 MB | 2–4 | Per-map distribution. |
| Compression ratio | 35–55% | — | LZ77 most files; ZLib for the largest. |
- **Some chunks expand when compressed.** A "compressed" chunk can be
  larger than 64 KiB if LZ77 found no matches. Treat `CompressedSize` as
  the authoritative length to copy.
- **The checksum is over encrypted bytes.** If you decrypt first, you'll
  fail the checksum.
- **Save games (`BANK` marker) are a different beast** — they reuse the
  HPI wrapper but the encoded contents are serialised game state, not a
  filesystem. kbot does not decode them.
- **`.gp3` requires the rev3.1 patch to load.** It's still an HPI inside,
  but the engine refuses to mount it on unpatched installs.

---

## Appendix — Full hex walk of `AFark.ufo`

`AFark.ufo` is the Arm Fark add-on — a small 9-file archive that's
ideal for end-to-end demonstration. We'll walk the **header**, decrypt
the **directory**, dissect a couple of entries, then peek at the
opening bytes of a **compressed chunk**.

### 1. Header (clear)

Raw bytes `0x00..0x14`:

```
00000000: 48 41 50 49 00 00 01 00 24 02 00 00 a6 00 00 00  HAPI....$.......
00000010: 14 00 00 00                                      ....
```

Decoded:

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `0x00` | `48 41 50 49` | `Marker` | `'HAPI'` ✓ |
| `0x04` | `00 00 01 00` | `Version` | `0x00010000` |
| `0x08` | `24 02 00 00` | `DirectorySize` | `0x224` = **548 bytes** |
| `0x0C` | `a6 00 00 00` | `DecryptKey` | byte `0xA6` |
| `0x10` | `14 00 00 00` | `Start` | `0x14` |

Derive the cipher key:

```
key = (0xA6 << 2) | (0xA6 >> 6)
    = 0x98 | 0x02
    = 0x9A
```

### 2. Decrypted directory (offsets `0x14..0x224`)

After running `plain[i] = cipher[i] ^ (uint8(0x14 + i) ^ 0x9A)` over
the directory blob — and inserting it into a 548-byte buffer at offset
`0x14` so pointers index correctly — the first 96 bytes read:

```
00000010                          08 00 00 00  1c 00 00 00 64 00 00 00
                                  ^^^^^^^^^^^  ^^^^^^^^^^^
00000020  6a 00 00 00 01 97 00 00  00 a0 00 00 00 01 c6 00
00000030  00 00 cf 00 00 00 01 13  01 00 00 1d 01 00 00 01
00000040  66 01 00 00 6e 01 00 00  01 94 01 00 00 9d 01 00
00000050  00 01 c3 01 00 00 c9 01  00 00 01 ef 01 00 00 f7
00000060  01 00 00 01 61 6e 69 6d  73 00 01 00 00 00 72 00
                      ^^^^^^^^^^^^^^^^^                     "anims"
```

At `0x14` we have **`0x00000008`** — the **root entry count**: 8
top-level subdirectories. At `0x18`, **`0x0000001C`** — the offset of
the first directory entry.

### 3. The first entry

The 9 bytes at `0x1C` decode as:

| Field | Bytes | Value |
|-------|-------|-------|
| `NameOffset` | `64 00 00 00` | `0x64` → "anims" string |
| `DataOffset` | `6a 00 00 00` | `0x6A` → subdirectory descriptor |
| `Flag` | `01` | `1` ⇒ subdirectory |

At `0x64`:

```
00000060  ....  61 6e 69 6d 73 00     ....anims.
                ^^^^^^^^^^^^^^^^^
```

The string `"anims\0"` — confirming the directory name.

At `0x6A`:

```
00000060  ....                  01 00 00 00 72 00      ........r.
                                ^^^^^^^^^^^ ^^^^
00000070  00 00 7b 00 00 00 ...                          ..{...
          ^^^^^
```

| Field | Bytes | Value |
|-------|-------|-------|
| Subdirectory `EntryCount` | `01 00 00 00` | `1` |
| Subdirectory `EntriesOffset` | `72 00 00 00` | `0x72` |

So the `anims/` directory contains **1 file**, described starting at
`0x72`:

| Field | Bytes | Value |
|-------|-------|-------|
| `NameOffset` | `7b 00 00 00` | `0x7B` → file name |
| `DataOffset` | `8e 00 00 00` | `0x8E` → file descriptor |
| `Flag` | `00` | `0` ⇒ file |

The name at `0x7B`:

```
00000070               .. .. .. 61 72 6d 66 61                armfa
00000080  72 6b 5f 67 61 64 67 65  74 2e 67 61 66 00         rk_gadget.gaf.
```

→ `"armfark_gadget.gaf"`.

The file descriptor at `0x8E` is a 9-byte `HPIFile`:

```
00000080                                              24 02              $.
00000090  00 00 48 48 00 00 01                                ..HH...
```

| Field | Bytes | Value |
|-------|-------|-------|
| `DataOffset` | `24 02 00 00` | **`0x0224`** — first byte after the directory! |
| `FileSize` | `48 48 00 00` | `0x4848` = 18504 bytes |
| `CompMethod` | `01` | `1` ⇒ LZ77 |

This matches `kbot hpi list -v`:

```
anims/armfark_gadget.gaf    18504
```

### 4. Reading the full tree

Continuing through the remaining 7 top-level entries produces:

```
.
├── anims/
│   └── armfark_gadget.gaf       (18504 B, LZ77)
├── download/
│   └── ARMFARK.TDF              (84 B, LZ77)
├── features/corpses/
│   └── armfark_dead.tdf         (619 B, LZ77)
├── objects3d/
│   ├── armfark.3do              (7337 B, LZ77)
│   └── armfark_dead.3do         (3551 B, LZ77)
├── scripts/
│   └── ARMFARK.COB              (18988 B, LZ77)
├── unitpics/
│   └── ARMFARK.PCX              (8728 B, LZ77)
├── units/
│   └── ARMFARK.FBI              (1466 B, LZ77)
└── weapons/
    └── armfark_weapon.tdf       (430 B, LZ77)
```

Nine files, the canonical shape of a single-unit `.ufo`.

### 5. A compressed chunk

The first byte after the 548-byte directory is at `0x224`. Decrypting
that region (the chunk header is also encrypted by the directory
cipher) reveals:

```
00000220                          .. 53 51 53 48 02 01 01 cc      .SQSH....
```

| Offset (from 0x224) | Bytes | Field | Value |
|--------------------:|:------|:------|:------|
| `+0` | `53 51 53 48` | `Marker` | `'SQSH'` ✓ |
| `+4` | `02` | `Version` | `0x02` (always) |
| `+5` | `01` | `CompMethod` | `1` ⇒ LZ77 |
| `+6` | `01` | `Encrypted` | `1` ⇒ apply the second XOR pass |
| `+7..` | … | `CompressedSize`, `DecompressedSize`, `Checksum`, then `data[]` | … |

Once you unscramble the chunk body with `data[i] = (data[i] - i) ^ i`
and run the resulting bytes through the LZ77 decoder described above,
you get the decompressed GAF — ready to hand off to a [GAF](gaf.md)
parser.

> [!TIP]
> **Reproduce this walk on your own machine.**
> ```bash
> # Show counts + key
> kbot hpi info  AFark.ufo
>
> # Walk the tree
> kbot hpi list  AFark.ufo -v
>
> # Pull a single file out, decompressed and ready to inspect
> kbot hpi extract AFark.ufo -p "anims/armfark_gadget.gaf" -t ./out
> kbot gaf list ./out/anims/armfark_gadget.gaf
> ```

---

## Appendix — Full hex walk of `Jersey.hpi` (HPI v2)

The TA: Kingdoms equivalent of the AFark walkthrough. `Jersey.hpi` is
a 67 KB voice-pack HPI that ships in the GoG TA:K install — six
sound-effect WAVs and nothing else. Small enough to walk end-to-end,
big enough to exercise every v2 mechanic (32-byte header, name pool,
SQSH-wrapped directory blob, single-chunk file payloads). The v1
walkthrough above covers everything that remains the same; this
section calls out only the v2 deltas.

### 1. The 32-byte header

```
00000000: 48 41 50 49 00 00 02 00 92 06 01 00 ad 00 00 00   HAPI............
00000010: 40 06 01 00 5b 00 00 00 20 00 00 00 3f 07 01 00   @...[... ...?...
```

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `0x00` | `48 41 50 49` | `Marker` | `'HAPI'` ✓ |
| `0x04` | `00 00 02 00` | `Version` | `0x00020000` — **v2** |
| `0x08` | `92 06 01 00` | `DirectoryBlock` | `0x00010692` — offset of the directory blob |
| `0x0C` | `ad 00 00 00` | `DirectorySize` | `0xAD` = 173 bytes |
| `0x10` | `40 06 01 00` | `NameBlock` | `0x00010640` — offset of the name pool |
| `0x14` | `5b 00 00 00` | `NameSize` | `0x5B` = 91 bytes |
| `0x18` | `20 00 00 00` | `Data` | `0x20` — file payloads start here, right after the header |
| `0x1C` | `3f 07 01 00` | `Last78` | `0x0001073F` — end-of-archive marker (0x1073F = 67391 = file size − 78 footer bytes) |

No XOR cipher, no decryption transforms, no per-position seed. The
header values point at absolute file offsets you can `seek` to
directly.

### 2. The name pool (raw text, near the tail)

At `DirectoryBlock` minus a few hundred bytes (the engine writes the
name pool before the directory) sits the string table:

```
00010640: 00 73 6f 75 6e 64 73 00 57 68 6f 64 69 65 64 2e   .sounds.Whodied.
00010650: 7761 7600 53 75 72 65 2e 77 61 76 00 57 68 6f   wav.Sure.wav.Who
00010660: 6168 5061 6c 6c 79 2e 77 61 76 00 46 6f 72 67   ahPally.wav.Forg
00010670: 6574 6162 6f 75 74 69 74 2e 77 61 76 00 59 6f   etaboutit.wav.Yo
00010680: 2e77 6176 00 49 67 6f 74 63 68 65 72 2e 77 61   .wav.Igotcher.wa
00010690: 76 00                                            v.
```

Every directory and file entry stores a `NamePtr` byte offset into
this block; following the pointer and reading until the next `\0`
gives you the name. Walking byte by byte:

| Offset (relative to `NameBlock`) | NUL-terminated string |
|---------:|--------|
| `0x00` | `""`           (root directory — empty name) |
| `0x01` | `"sounds"`     (the only sub-directory) |
| `0x08` | `"Whodied.wav"` |
| `0x14` | `"Sure.wav"` |
| `0x1D` | `"WhoahPally.wav"` |
| `0x2C` | `"Forgetaboutit.wav"` |
| `0x3E` | `"Yo.wav"` |
| `0x45` | `"Igotcher.wav"` |

> [!NOTE]
> **The name pool's nominal size includes a few unused trailing
> bytes.** `NameSize=0x5B` runs to offset `0x1069B`, but the last
> meaningful byte (the NUL after `Igotcher.wav`) is at `0x10691`.
> The 9 trailing bytes overlap into the start of the SQSH directory
> chunk and are never indexed by any `NamePtr` — readers tolerate them
> simply by never looking at them.

### 3. The directory blob (SQSH-wrapped)

At `0x10692` the directory blob starts with a SQSH chunk header — v2
re-uses the v1 chunk format:

```
00010692: 53 51 53 48 02 02 01 9a 00 00 00 b8 00 00 00 9b   SQSH............
000106a2: 4f 00 00 78 9e 63 …                              O..x.c…
```

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `+0` | `53 51 53 48` | `Marker` | `'SQSH'` ✓ |
| `+4` | `02`          | `Version` | `2` |
| `+5` | `02`          | `CompMethod` | `2` ⇒ ZLib |
| `+6` | `01`          | `Encrypted` | `1` — chunk body has the second XOR pass applied (rare in TAK; this archive has it) |
| `+7` | `9a 00 00 00` | `CompressedSize` | `0x9A` = 154 bytes |
| `+11` | `b8 00 00 00` | `DecompressedSize` | `0xB8` = 184 bytes |
| `+15` | `9b 4f 00 00` | `Checksum` | `0x4F9B` |
| `+19..+172` | … | `data[]` | 154 bytes of XOR-scrambled ZLib stream |

`19 + 154 = 173 = 0xAD = DirectorySize`, so the whole chunk fits the
header's claim. After undoing the XOR pass (same algorithm as v1) and
running through `inflate`, you get **184 bytes** of packed directory
records.

### 4. Decoding the directory records

The decompressed blob holds a packed array of two record types: 20-byte
**directory entries** (`HpiDir2`) and 24-byte **file entries**
(`HpiEntry2`). There's no count prefix or offset table — the root
directory always sits at offset `0` of the blob, and its
`FirstSubDirectory` / `FirstFile` fields point at the children.

The root `HpiDir2` (at decompressed offset 0, 20 bytes):

| Offset | Bytes (decompressed) | Field | Value |
|-------:|:---------------------|:------|:------|
| `+0` | `00 00 00 00` | `NamePtr` | `0` → `""` (root) |
| `+4` | `14 00 00 00` | `FirstSubDirectory` | `0x14` — single 20-byte sub-dir record at this offset |
| `+8` | `01 00 00 00` | `SubCount` | `1` (the `sounds/` directory) |
| `+12` | `00 00 00 00` | `FirstFile` | `0` — no files at the root |
| `+16` | `00 00 00 00` | `FileCount` | `0` |

Following the pointer to `0x14` lands on the `sounds` `HpiDir2`:

- `NamePtr = 0x01` → `"sounds"`
- `FirstSubDirectory = 0`, `SubCount = 0` — no nested subdirs
- `FirstFile = 0x28` — first of six `HpiEntry2` records (24 bytes each)
- `FileCount = 6`

Each file record at `0x28`, `0x40`, `0x58`, … carries:

```c
NamePtr           // → name pool offset
Start             // → absolute file offset of the SQSH chunk (or stored bytes)
DecompressedSize
CompressedSize    // 0 ⇒ stored verbatim (no SQSH wrapper)
Date              // time_t, informational
Checksum          // informational
```

Decoded, the six entries correspond exactly to what `kbot hpi list`
reports:

```
sounds/Whodied.wav        56474 bytes
sounds/Sure.wav           15248 bytes
sounds/WhoahPally.wav     24826 bytes
sounds/Forgetaboutit.wav  24826 bytes
sounds/Yo.wav             19368 bytes
sounds/Igotcher.wav       35980 bytes
```

### 5. What's NOT here (vs. v1)

If you have the v1 walkthrough fresh in mind, the missing pieces are
the whole point of v2's simplification:

- **No XOR cipher derivation** — `DecryptKey` is always `0` for v2.
  Even when a SQSH chunk has `Encrypted == 1`, the second-pass XOR
  inside the chunk is still applied, but the directory/payload
  envelope is plaintext.
- **No per-position seed** — the byte-by-byte cipher that complicated
  v1 readers (decryption depends on absolute file offset) doesn't
  exist at the v2 envelope level.
- **No chunk size table** — v1 files chunked into ≤64 KiB blocks with
  a leading uint32-size array. v2 stores each file as a **single**
  SQSH chunk (or stored bytes), so there's nothing to size-table.
- **No `0x14` directory-immediately-after-header convention** — the
  directory and name blocks live wherever the writer parked them
  (typically near the file tail). The header points at them.

> [!TIP]
> **Reproduce this walk on your own machine.**
> ```bash
> kbot ctx add /path/to/tak --alias tak --game takingdoms
> kbot hpi info  /path/to/tak/Jersey.hpi
> kbot hpi list  /path/to/tak/Jersey.hpi -v
> kbot hpi extract /path/to/tak/Jersey.hpi -t ./jersey-out
> # And to peek at the raw bytes:
> xxd -l 64 /path/to/tak/Jersey.hpi          # 32-byte v2 header
> xxd -s 0x10640 -l 96 /path/to/tak/Jersey.hpi   # name pool
> xxd -s 0x10692 -l 32 /path/to/tak/Jersey.hpi   # SQSH directory chunk header
> ```

---

## See also

- [GAF](gaf.md), [PCX](pcx.md), [3DO](3do.md), [TNT](tnt.md), [COB](cob.md),
  [TDF](tdf.md) — the kinds of files HPI archives contain.
- [Glossary](glossary.md) — definitions of *virtual filesystem*, *layering*,
  and other HPI-adjacent terms.
