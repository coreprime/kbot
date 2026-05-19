# WAV — Sound Effects & Sound Bank Wiring

> Total Annihilation's sound effects (unit voice samples, weapon
> impacts, UI clicks) are **vanilla 8-bit / 16-bit PCM WAV** files —
> nothing TA-specific about the container. The interesting part is the
> **wiring**: how unit FBIs, weapon TDFs, and the global UI route
> filenames into the sound bus via three layers of indirection.

> [!TIP]
> **Try it yourself.**
> ```bash
> # Play one directly
> ls $(kbot ctx path)/sounds/ | head
> afplay $(kbot ctx path)/sounds/cmdsel1.wav   # macOS
> aplay  $(kbot ctx path)/sounds/cmdsel1.wav   # Linux
>
> # The web UI also previews WAV/MP3 inline
> kbot mount $(kbot ctx path) --server
> ```

---

## On-disk: it's just WAV

WAV files live in `sounds/`. They follow the standard RIFF WAVE format
— anything that plays WAVs plays these. kbot does not parse them as a
custom format; the explorer hands them off to the browser's `<audio>`
element.

**Typical encoding** in Cavedog's shipped files:

| Property | Value |
|----------|-------|
| Sample rate | 22050 Hz (most), 11025 Hz (some UI clicks) |
| Bit depth | 8-bit unsigned PCM |
| Channels | Mono |
| Duration | 0.1–3 seconds |
| File size | 5 KB – 200 KB |

Mods occasionally ship 16-bit stereo samples; the engine accepts them
but they cost more memory.

---

## The three layers of wiring

Looking up "what plays when the Arm Commander is selected" follows
this chain:

```
   FBI                gamedata/sound.tdf            sounds/
┌─────────────┐     ┌───────────────────────┐    ┌──────────────┐
│ units/      │     │ [ARM_COM]             │    │ cmdsel1.wav  │
│ armcom.fbi  │     │   {                   │    │              │
│             │ ──▶ │     select1=cmdsel1;  │ ──▶│              │
│ Sound       │     │     ok1=cmdok1;       │    │              │
│ Category=   │     │     ...               │    │              │
│   ARM_COM;  │     │   }                   │    │              │
└─────────────┘     └───────────────────────┘    └──────────────┘
   1. FBI picks       2. sound.tdf maps             3. WAV file
      a category         event → filename              on disk
```

### Layer 1 — `SoundCategory` on the FBI

A unit's [FBI](tdf.md) names a category:

```ini
[UNITINFO]
{
    UnitName=ARMCOM;
    SoundCategory=ARM_COM;     // ← points at [ARM_COM] in sound.tdf
    ...
}
```

Categories are *shared* across units — every Arm Commander variant,
or every Arm K-bot, points at the same category so that selection
voices stay consistent within a side.

### Layer 2 — `gamedata/sound.tdf`

The TDF binds engine events to WAV filenames within a category:

```ini
[ARM_COM]
{
    select1=cmdsel1;       // Selecting the unit
    ok1=cmdok1;            // Movement order acknowledged
    arrived1=cmdarvd1;     // Reached destination
    cant1=cantdo4;         // Order rejected ("I can't do that")
    underattack=warning1;  // Took damage
    count5=count1;         // Commander self-destruct countdown (5)
    count0=count6;         // …countdown (now)
    canceldestruct=cancel2;
}
```

Note the **`1` suffix** on most event names. Many event keys come as
families (`select1`, `select2`, `select3`, …); the engine picks one at
random for variety. With only `select1` defined, the same line plays
every time.

### Layer 3 — `sounds/<name>.wav`

The TDF value is the **stem** (no `.wav` extension). The engine looks
up `sounds/<stem>.wav` in the virtual filesystem.

> [!IMPORTANT]
> **The `.wav` suffix is implied.** If you write `select1=cmdsel1.wav`
> in the TDF, the engine will try to find `sounds/cmdsel1.wav.wav` and
> silently play nothing.

---

## Standard event keys

The most useful keys in a unit's `[SOUNDS]` block — either inlined into
the FBI or routed via the `SoundCategory` lookup:

| Key | When it fires |
|-----|---------------|
| `select1`–`selectN` | Unit selected. |
| `ok1`–`okN` | Movement order accepted. |
| `arrived1`–`arrivedN` | Unit completes move. |
| `cant1`–`cantN` | Order rejected (terrain, build queue, etc.). |
| `underattack` | Unit takes damage. |
| `count0`–`count5` | Self-destruct countdown ticks. |
| `canceldestruct` | Self-destruct aborted. |
| `build` | Constructor begins building. |
| `repair` | Constructor begins repairing. |
| `working` | Constructor reclaiming/resurrecting. |
| `capture` | Commander/capture-capable unit begins capturing. |
| `activate` / `deactivate` | On/off toggle (radar, jammer, fortifications). |
| `pcktle1`–`pcktleN` | "Picked from group", spoken when multi-selecting. |

The full list lives in Cavedog's `gamedata/allsound.tdf`, which is a
single flat reference of every event the engine emits.

---

## UI sounds — `allsound.tdf`

UI events (button clicks, menu transitions, end-game stingers) are
keyed the same way but live in `[GLOBAL_*]`-style sections of
`gamedata/allsound.tdf`:

```ini
[BIGBUTTON]   { sound=butmain1; }
[SMLBUTTON]   { sound=button1;  }
[SKIRMISH]    { sound=butnskir; }
[BGM]         { sound=drone2;   }   // Background music ID
```

These sections are referenced by name from the menu `.gui` files. To
change the "Skirmish" button's click sound, you only need to edit this
TDF — no `.gui` editing.

---

## Weapon sounds

Weapon TDFs ([TDF](tdf.md)) carry their own sound keys directly,
without an indirection layer:

```ini
[LIGHTLASER] {
    ...
    soundstart=lasrmas1;     // On fire
    soundhit=lasrhit1;       // On impact
    soundwater=splshbig;     // On water hit (overrides soundhit)
    soundtrigger=1;          // Play soundstart on each burst pulse, not just first
}
```

The same `sounds/<stem>.wav` lookup applies. Weapon sounds are tuned
per-shot — if you change a unit's weapon, you'll need to retune the
sound levels in the weapon TDF too.

---

## Worked example — adding a new selection voice

1. Drop a new WAV in `sounds/` (mono, 22050 Hz, 8-bit recommended):

   ```
   mymod/sounds/cmdsel_grunt.wav
   ```

2. Add a new event in `gamedata/sound.tdf`:

   ```ini
   [ARM_COM]
   {
       select1=cmdsel1;       // Existing
       select2=cmdsel_grunt;  // Your new line, randomly selected
   }
   ```

3. No FBI change required — the existing `SoundCategory=ARM_COM`
   reference is enough.

4. Pack and test:

   ```bash
   kbot hpi pack ./mymod --target mymod.ufo
   ```

The engine will now alternate between `cmdsel1.wav` and
`cmdsel_grunt.wav` when the commander is selected.

---

## Typical sizes

| Asset | Range observed in Cavedog assets |
|-------|----------------------------------|
| Unit voice line | 5–60 KB |
| Weapon impact | 5–30 KB |
| Explosion | 30–120 KB |
| Music loop | 100 KB – 1 MB |
| `gamedata/sound.tdf` | ~20 KB (300+ categories) |
| `gamedata/allsound.tdf` | ~6 KB |

---

## Gotchas

> [!WARNING]
> **A missing WAV is silent, not an error.** Misspell `select1=cmsdel1`
> (transposed letters) and the engine simply plays nothing on
> selection — no log message, no fallback. Always test changed sounds
> in-game.

- **The `.wav` extension is implied** — never write it in the TDF value.
- **Sample rate matters.** Sounds played outside 8 kHz / 11.025 kHz /
  22.05 kHz / 44.1 kHz can stutter on Windows 9x-era hardware paths
  some retail engines still use. 22050 Hz mono is the safe default.
- **Stereo WAVs are mixed down to mono** by the engine. Don't ship
  stereo unless you have a specific spatial reason.
- **MP3 in `sounds/`** — the engine ignores MP3s here. The music
  player has a separate code path for `music/*.mp3`.
- **Cavedog ships some WAVs with 16-bit PCM and bizarre sample rates
  (e.g. 7000 Hz)** — these still work, but if you're building tooling
  that assumes 22050/8/mono you'll trip over them.

---

## See also

- [TDF](tdf.md) — the format used by `sound.tdf`, `allsound.tdf`, and
  weapon sound fields.
- [TA: Kingdoms GUI](takgui.md) — `.gui` widgets reference UI sound
  events.
- [Glossary](glossary.md) — *sound category*.
