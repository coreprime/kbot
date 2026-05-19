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
> The Smacker format itself was reverse-engineered by the FFmpeg
> project years ago and is well-supported by modern tools. kbot uses
> **FFmpeg** as the conversion engine (it ships built-in Smacker
> decoders and, on most builds, encoders too).

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot zrb info     data/1.zrb               # header summary
> kbot zrb to-mp4   data/1.zrb -t intro.mp4  # decode to MP4 (requires ffmpeg)
> kbot zrb from-mp4 intro.mp4 -t out.zrb     # re-encode to Smacker
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
sequence, mission briefings, etc. Resolution is typically **640 × 240**
(letterboxed 4:3 with VGA-mode squashing) at **30 fps**.

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
    uint32 AudioRate[7];
    uint32 dummy;            // 4-byte reserved
    uint32 AudioFlags[7];    // Bits 0-15: format; bits 16-23: channels
    // …followed by:
    uint32 FrameSizes[Frames];
    uint8  FrameTypes[Frames];
    uint8  HuffmanTrees[TreesSize];
} SmackerHeader;
```

### Decoding the frame rate

The sign of `FrameRate` chooses between two encodings:

| Value | Meaning |
|------:|---------|
| `> 0` | Microseconds per frame: `fps = 1_000_000 / FrameRate`. |
| `< 0` | Negative deci-microseconds: `fps = 100_000 / abs(FrameRate)`. |
| `0` | No frame-rate info — kbot defaults to 15 fps. |

For 30 fps you'll usually see `-3333` (≈ `-100000/30`).

### Signature variants

- **`SMK2`** — original Smacker format. Almost all Cavedog cinematics
  use this.
- **`SMK4`** — extended format with improved compression. Rare in TA;
  occasionally seen in mods using newer RAD tooling.

kbot accepts both; the FFmpeg path handles both transparently.

### Audio tracks

Up to 7 simultaneous audio tracks. Each track has its own sample rate
(`AudioRate[i]`) and a `AudioFlags[i]` word splitting format bits and
channel count. A track is "present" only if `AudioFlags[i] != 0`.

> [!NOTE]
> **Cavedog's ZRB files often have a single mono track in slot 0** at
> 22.05 kHz. The other six slots are zeroed.

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

`kbot zrb to-mp4` invokes FFmpeg with sensible defaults:

```
ffmpeg -i in.zrb \
       -c:v libx264 -preset fast -crf 18 \
       -c:a aac -b:a 192k \
       -y out.mp4
```

These flags target visually-lossless quality (CRF 18) at high audio
fidelity. Adjust if you need smaller files.

The reverse direction (`from-mp4`) requires an FFmpeg build with the
`smackvid` / `smackaud` encoders enabled. Many distributions ship
without those — the error message will tell you so. RAD's own SmkUtil /
Bink tools remain the gold standard for re-encoding.

> [!IMPORTANT]
> **`from-mp4` is a best-effort path.** Smacker's compression scheme is
> tuned for very low-CPU playback rather than fidelity; even when
> encoding works, expect quantisation noise on gradients. For final
> shipping cinematics, run a separate pass through RAD's official
> tools.

---

## Typical sizes

| Asset | Resolution | Frames | Duration | File size |
|-------|-----------|--------|----------|-----------|
| Intro cinematic (`data/1.zrb`) | 640 × 240 | 599 | ~20 s | ~3 MB |
| Short mission brief (`data/N.zrb`) | 640 × 240 | 100–300 | 3–10 s | 0.5–2 MB |

---

## Gotchas

> [!WARNING]
> **`AudioRate` and `AudioFlags` slots may contain stale data** even
> when the corresponding track is not used. Only treat track `i` as
> present if `AudioFlags[i] != 0`. kbot's `Info()` output prints all
> seven slots regardless, which is why you'll see lines like
> `Track 0: 3489682978 Hz, 1 channels` — the 3.4 GHz "sample rate" is
> uninitialised memory the file ships with, not a real value.

- **Smacker is not Bink.** RAD released Smacker first, then Bink as
  its successor. TA only uses Smacker. Don't try to load `.bik` files
  with `kbot zrb`.
- **`SMK4` Huffman trees are not backward-compatible with `SMK2`
  decoders.** FFmpeg handles both, but older third-party libraries
  may not.
- **A few Cavedog cinematics ship with negative `FrameRate` values that
  decode to non-integer fps** (e.g. `-3300` → 30.30 fps). MP4
  converters generally clamp to integer fps — drop your shutter to
  `30000/1001` if you care about exact timing.
- **Renaming `.zrb` ↔ `.smk` is harmless** but the game expects `.zrb`
  in the `data/` directory. Don't ship `.smk`-named files to the
  engine.

---

## See also

- [HPI](hpi.md) — the wrapper archive that ships ZRB files.
- [Glossary](glossary.md) — *frame rate*, *signature*.
