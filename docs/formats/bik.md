# Bink — TA: Kingdoms Cutscene Video

> *Total Annihilation: Kingdoms* replaced the original game's **Smacker**
> (`.zrb`) cinematics with RAD Game Tools' newer **Bink** codec, stored as
> `.bik`. The mission intros, faction briefings and outros all ship as Bink
> 1 files under `movies/`.
>
> | Extension | Used by | Notes |
> |-----------|---------|-------|
> | `.bik` | TA: Kingdoms `movies/*.bik` | RAD Bink 1. Signature `BIK` + a revision byte (`BIKf` in TA:K). |
>
> Bink is **not** Smacker — it is a separate, later codec with its own
> DCT-based video bitstream and its own audio (Bink Audio, DCT or RDFT).
> kbot parses the container header natively but delegates pixel decoding to
> **FFmpeg**, which ships a Bink 1 decoder (`binkvideo`,
> `binkaudio_dct`/`binkaudio_rdft`).

> [!TIP]
> **Try it yourself.**
> ```bash
> kbot bik info   movies/takmission14_ph.bik          # header summary
> kbot bik to-mp4 movies/takmission14_ph.bik out.mp4  # decode to MP4 (requires ffmpeg)
> ```
>
> **From Go.** Use [`formats/bik`](../../formats/bik/bik.go):
> ```go
> import "github.com/coreprime/kbot/formats/bik"
>
> r, _ := bik.OpenReader("movies/takmission14_ph.bik")
> defer r.Close()
> fmt.Println(r.Width(), r.Height(), r.FrameCount(), r.FrameRate())
> _ = bik.ConvertToMP4("movies/takmission14_ph.bik", "out.mp4")
> ```

---

## What you'll find in a TA: Kingdoms install

```
$ ls $(kbot ctx path)/movies/*.bik
takmission01_ph.bik  takmission14_ph.bik  takx21_dh.bik  …
$ ls $(kbot ctx path)/movies/gui/*.bik
snort4.bik  snort6.bik  …          # tiny UI stingers, often a few KB
```

A typical mission cinematic is **640 × 350 at 15 fps** with a single 16-bit
stereo audio track (~22 kHz). The `movies/gui/` clips are much smaller and
sometimes have **odd dimensions** (e.g. 124 × 101) — see the gotcha below.

---

## Header layout (Bink 1)

All fields are little-endian. kbot reads up to and including the audio-track
tables; the per-frame index and compressed bitstream are left to FFmpeg.

```c
typedef struct {
    char   Signature[4];   // 'B','I','K', revision  (revision 'f' in TA:K)
    uint32 FileSize;       // total file size minus 8
    uint32 Frames;         // video frame count
    uint32 LargestFrame;   // size in bytes of the biggest frame
    uint32 FramesCopy;     // duplicate frame count (ignored)
    uint32 Width;
    uint32 Height;
    uint32 FPSNum;         // frame rate numerator
    uint32 FPSDen;         // frame rate denominator
    uint32 VideoFlags;     // bit 0x00100000 = alpha plane, 0x00020000 = grayscale
    uint32 NumAudioTracks;
    // if NumAudioTracks > 0:
    uint32 AudioMaxSize[NumAudioTracks];   // per-track max packet (ignored)
    struct { uint16 SampleRate; uint16 Flags; } AudioInfo[NumAudioTracks];
    uint32 AudioTrackID[NumAudioTracks];
    // followed by:
    uint32 FrameOffsets[Frames + 1];       // LSB of each offset is the keyframe flag
} BinkHeader;
```

### Frame rate

`fps = FPSNum / FPSDen`. TA:K cinematics use `15 / 1`. Because it is a
rational pair the value can be fractional, so kbot keeps it as a float.

### Audio flags (the 16-bit `Flags` word)

| Bit | Meaning |
|----:|---------|
| `0x4000` | 16-bit samples (else 8-bit) |
| `0x2000` | stereo (else mono) |
| `0x1000` | DCT codec (else RDFT) |

> [!NOTE]
> The `SampleRate` is the literal stored value — TA:K ships `22254` Hz, not a
> round `22050`. kbot reports it verbatim.

---

## Conversion is decode-only

`kbot bik to-mp4` invokes FFmpeg:

```
ffmpeg -i in.bik \
       -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" \
       -c:v libx264 -preset fast -crf 18 \
       -c:a aac -b:a 192k \
       -y out.mp4
```

There is **no `from-mp4`**. Unlike Smacker — where some FFmpeg builds carry
the `smackvid`/`smackaud` encoders — **no open-source Bink encoder exists**.
Only RAD's proprietary tools produce `.bik` files. This is the one capability
Bink support cannot match the [Smacker/ZRB](smacker.md) command on.

> [!WARNING]
> **Odd dimensions.** Several `movies/gui/*.bik` clips have dimensions that
> are not divisible by 2 (e.g. 124 × 101). H.264 with `yuv420p` requires even
> width and height, so the converter pads up to the next even size with a
> `pad` filter rather than rescaling — no pixels are resampled, a black edge
> row/column is added instead.

---

## Gotchas

- **Bink is not Smacker.** Don't point `kbot zrb` at a `.bik` (or `kbot bik`
  at a `.zrb`); the signatures and codecs differ entirely.
- **Bink 2 (`KB2`) is not supported.** TA:K predates Bink 2, so every shipped
  file is Bink 1 (`BIK*`). kbot rejects `KB2*` with a clear error.
- **Encrypted Boneyards stingers.** A handful of files under
  `boneyards/metagame/*.bik` (e.g. `ftuimovie2.bik`) carry the `.bik`
  extension but are **not** Bink containers — they are scrambled/obfuscated
  payloads for the online metagame UI. kbot rejects them as invalid rather
  than guessing.

---

## See also

- [Smacker / ZRB](smacker.md) — the original-TA cutscene format Bink replaced.
- [HPI](hpi.md) — the wrapper archive that ships these files.
