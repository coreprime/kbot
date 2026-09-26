# Smacker / ZRB — Cutscene Video

> Total Annihilation's intro, mission briefings, and outro cinematics
> are **RAD Game Tools Smacker** videos. They are stored with two
> different extensions:
>
> | Extension | Used by | Notes |
> |-----------|---------|-------|
> | `.smk` | Generic Smacker tooling | Standard RAD format. |
> | `.zrb` | TA's `data/*.zrb` payload | Cavedog renamed Smacker files to `.zrb` to discourage casual extraction. The binary contents are byte-identical. |
>
> FFmpeg decodes Smacker natively, and kbot uses it as the conversion
> engine for Smacker → MP4. **Nothing converts the other way:** stock
> FFmpeg has no Smacker encoder or muxer and kbot has no Smacker writer.
> SMK2 movies for TA are made with RAD Game Tools' Smacker tools.

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot zrb info     data/1.zrb               # header summary
> kbot zrb to-mp4   data/1.zrb intro.mp4     # decode to a 640x480 MP4 (requires ffmpeg)
> kbot zrb from-mp4 intro.mp4 out.zrb        # reports that no Smacker encoder exists
> ```
>
> **From Go.** Use [`formats/smacker`](../../formats/smacker/smacker.go):
> ```go
> import "github.com/coreprime/kbot/formats/smacker"
>
> r, _ := smacker.OpenReader("data/1.zrb")
> defer r.Close()
> fmt.Println(r.Width(), r.Height(), r.FrameCount(), r.FrameRate())
> _ = smacker.ConvertToMP4("data/1.zrb", "intro.mp4")
> ```

---

## What you'll find in a TA install

```
$ ls $(kbot ctx path)/data/*.zrb
1.zrb  2.zrb  3.zrb  4.zrb  5.zrb
```

Each numbered file is a cinematic — the original "Arm vs Core" intro
sequence, mission briefings, etc. The frames are stored at **640 × 240**
with the **interlaced** flag set, so the game shows them at **640 × 480**
with every second line black, at **30 fps**. `kbot zrb to-mp4`, the MCP
`zrb_to_mp4` tool and the studio's video player (and its thumbnails) show
them the same way.

---

## Header (104 bytes minimum)

The Smacker header carries a signature, geometry, frame counts, audio
config, and pointer-table sizes. Reading it is straightforward but the
**body decoding is bit-level Huffman trees**, which is why kbot punts
on the body and uses FFmpeg.

```c
typedef struct {
    uint32 Signature;        // 'SMK2' = 0x324B4D53 or 'SMK4' = 0x344B4D53
    uint32 Width;
    uint32 Height;
    uint32 Frames;
    int32  FrameRate;        // See below — sign-encoded
    uint32 Flags;
    uint32 AudioSize[7];
    uint32 TreesSize;        // Huffman tree section length
    uint32 MMapSize;
    uint32 MClrSize;
    uint32 FullSize;
    uint32 TypeSize;
    uint32 AudioRate[7];     // packed: rate in bits 0-23, flags in bits 24-31
    uint32 dummy;            // 4-byte reserved; the header ends here (104 bytes)
    // …followed by one entry per frame, plus one for the ring frame
    // when Flags bit 0 is set:
    uint32 FrameSizes[Frames (+1)];
    uint8  FrameTypes[Frames (+1)];
    uint8  HuffmanTrees[TreesSize];
} SmackerHeader;
```

`Flags` bits: `0x01` ring frame (one extra frame after the last, for
looping), `0x02` interlaced (shown at twice the height with every second
line black), `0x04` doubled (shown at twice the height with every line
repeated). With both `0x02` and `0x04` set the movie is shown at its
stored height.
```

### Decoding the frame rate

The sign of `FrameRate` chooses between two encodings:

| Value | Meaning |
|------:|---------|
| `> 0` | Milliseconds per frame: `fps = 1000 / FrameRate`. |
| `< 0` | Hundred-thousandths of a second per frame: `fps = 100_000 / abs(FrameRate)`. |
| `0` | No defined timing — kbot uses 15 fps. |

For 30 fps you'll usually see `-3333` (≈ `-100000/30`).

### Signature variants

- **`SMK2`** — original Smacker format. Almost all Cavedog cinematics
  use this.
- **`SMK4`** — extended format with improved compression, from newer RAD
  tooling. **TA 3.1c plays SMK2 only.**

kbot reads both (and notes an SMK4 file); FFmpeg decodes both.

### Audio tracks

Up to 7 audio tracks. Each `AudioRate[i]` word packs the sample rate
(bits 0–23) and the track's flags (bits 24–31): `0x80` compressed,
`0x40` present, `0x20` 16-bit (else 8-bit), `0x10` stereo (else mono).
**The game uses a track only when its present bit is set**, whatever its
rate. There is no separate flags table: the seven words after the header
are the frame-size table.

> [!NOTE]
> **Cavedog's ZRB files have a single track in slot 0**: the word
> `0xD0005622` — present, 22,050 Hz, stereo, 8-bit, compressed. The other
> six slots are zeroed. `kbot zrb info` and the MCP `zrb_info` tool list
> the present tracks only.

---

## The "data is encrypted" myth

A common modder belief is that `.zrb` files are an encrypted variant of
Smacker. **They are not.** Renaming `1.zrb` to `1.smk` makes them
playable in any Smacker-aware tool (RAD Bink/Smacker tools, FFmpeg,
VLC). Cavedog's only obfuscation was the extension itself.

```bash
# Equivalent — try both
ffplay data/1.zrb
cp data/1.zrb /tmp/intro.smk && ffplay /tmp/intro.smk
```

---

## Conversion pipelines

`kbot zrb to-mp4` reads the header, then has FFmpeg decode the movie to
H.264 (CRF 18) and AAC **as the game shows it**: at the display height
(an interlaced 640×240 movie becomes 640×480 with every second line
black), with square pixels, stopping at the header's frame count (a ring
frame is not shown).

| Flag | Effect |
|------|--------|
| `--line-double` | Fill an interlaced movie's extra lines by repeating each stored line instead of black. |
| `--stored-height` | Keep the stored frame height (640×240). |

The studio's video player uses the same conversion, and its thumbnails
keep the 4:3 display shape (128×96, lines doubled).

> [!IMPORTANT]
> **There is no MP4 → Smacker path.** Stock FFmpeg has no Smacker
> encoder (`smackvid` / `smackaud`) or muxer, and kbot has no Smacker
> writer. `kbot zrb from-mp4` and the MCP `zrb_from_mp4` tool report
> exactly that (and only try FFmpeg when it lists both a `smackvid`
> encoder and an `smk` muxer). Make SMK2 movies for TA with RAD Game
> Tools' Smacker tools.

---

## Typical sizes

| Asset | Resolution | Frames | Duration | File size |
|-------|-----------|--------|----------|-----------|
| Intro cinematic (`data/1.zrb`) | 640 × 240 (shown 640 × 480) | 599 | ~20 s | ~7 MB |
| Other cinematics (`data/2.zrb`–`5.zrb`) | 640 × 240 (shown 640 × 480) | — | — | 10–41 MB |

---

## Gotchas

> [!WARNING]
> **`AudioRate` is a packed word, not a rate.** Read as a plain number the
> retail word `0xD0005622` is 3,489,682,978 "Hz". Mask the low 24 bits for
> the rate and test bit `0x40000000` for presence. Tools that read seven
> more "flags" words after the header are reading the frame-size table.

- **Smacker is not Bink.** RAD released Smacker first, then Bink as
  its successor. TA only uses Smacker; TA: Kingdoms switched to Bink.
  Don't load `.bik` files with `kbot zrb` — use [`kbot bik`](bik.md) instead.
- **`SMK4` Huffman trees are not backward-compatible with `SMK2`
  decoders.** FFmpeg handles both, but older third-party libraries
  may not.
- **The shipped cinematics store `-3333`** (100,000 / 3,333 ≈ 30.003
  fps).
- **The stored height is not the shown height.** Check the interlaced
  and doubled flags; playing the retail movies at 640×240 squashes them
  to half height.
- **Renaming `.zrb` ↔ `.smk` is harmless** but the game expects `.zrb`
  in the `data/` directory. Don't ship `.smk`-named files to the
  engine.

---

## See also

- [Bink](bik.md) — the successor codec TA: Kingdoms uses in place of Smacker.
- [HPI](hpi.md) — the wrapper archive that ships ZRB files.
- [Glossary](glossary.md) — *frame rate*, *signature*.
