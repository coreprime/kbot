# TA: Kingdoms `.gui` — Whitespace-Delimited Widget Trees

> *TA: Kingdoms* drew its main menu, lobby, in-game HUD, and dialog
> boxes from `.gui` files — a quirky, **whitespace-delimited** widget
> description format. Despite the visual similarity to TA's own GUI
> files (also `.gui`), the TA:K format is structurally different and
> non-interchangeable.

> [!NOTE]
> kbot does not currently ship a TA:K `.gui` subcommand — the format is
> documented here for completeness and to inform future tooling. You can
> still inspect these files by hand; they're plain ASCII text.

---

## What you're looking at

A `.gui` file is a flat sequence of **widgets**. The file's header
widget declares total widget count and global metadata (background
image, hotkeys); every widget after that describes a single UI element.

A typical widget looks like:

```
4 1                                       ← widget type (4 = button), unused flag (always 1)
1                                         ← unused (always 1 except in headers)
2 196 79 95 20 1 0 0 0                    ← bounds: type, X, Y, W, H, flags…
3 0 0 0 0                                 ← colour: type, R, G, B, A
1 0 0                                     ← unused (always 1 0 0)
1 14 hattfont11.gaf                       ← font: type, len, name
12 PlayerColor 2 12                       ← control name + state count
3                                         ← number of gaf frames that follow
1 17 singlemachine.gaf 14 SingleMachine0 0 18    ← disabled frame
1 17 singlemachine.gaf 14 SingleMachine0 1 18    ← pressed frame
1 17 singlemachine.gaf 14 SingleMachine0 2 18    ← released frame
3                                         ← number of strings that follow
2 0 0 2 0 4 Exit 2 0 4 Exit 3             ← state strings (disabled, pressed, up)
1 7 Default
1 12 skirmish.wav                         ← sound played when activated
1 7 Default
2 0 16 Play the Machine                   ← tooltip / mouseover help
0                                         ← number of child widgets
```

Tokens are whitespace-separated. **The first token of each widget is
the widget-type ID**; everything after follows a per-type schema.

---

## Length-prefixed strings

The most important trick in the format: **every string is preceded by
its length in characters as an integer token**. This means strings can
contain spaces — but the parser must read the length first.

```
1 14 MainScreen.gaf
^ ^^ ^^^^^^^^^^^^^^
│  │  │
│  │  └─ the string itself (14 characters)
│  └─ length
└─ string-flavour prefix (1 = literal string)
```

A null/empty string is `1 0 0` (prefix, zero length, the empty payload
is "the empty string"). The repeated `1`/`0` prefixes are very easy to
misparse if you simply tokenise on whitespace and start counting — you
have to read sequentially in widget order.

> [!IMPORTANT]
> **You cannot meaningfully grep a `.gui` file for "the third button"**
> — the structure is sequential, not addressable. Editors written
> against this format are sequential parsers.

---

## Widget types

Observed widget-type IDs:

| ID | Widget | Notes |
|---:|--------|-------|
| `2` | Header / form | First widget in the file. Carries background, hotkeys, child count. |
| `4` | Button | 3-state (disabled / pressed / up). |
| `5` | Checkbox | 5-state matrix (disabled, off-down, on-down, off-up, on-up). |
| `9` | Frame | Invisible container; groups widgets visually only. |
| `12` | Scrollbar container | Bounds the slider and its inc/dec buttons. |
| `14` | Scrollbar button (inc / dec / thumb) | Three of these follow each `12`. |
| `15` | Listbox | Run-time-populated; templates are nearly empty. |
| `17` | Radio button | 3-state. |
| `18` | Multi-state button | N-state cycle button (e.g. "AI difficulty" selector). |
| `19` | Image + Label | TA:K's combined widget for static art + caption. |

Each type has a fixed schema for the tokens after the type ID. The
canonical schema reverse-engineered by Dark Rain is preserved in the
source materials accompanying this repo.

---

## Generic widget shape

```
[TYPE] 1
1
2  [X] [Y] [W] [H] 1 0 0 0
3  [colour: A R G B]
1 0 0
1 [font: length name]
[control-name length] [name] 2 3
[N]
1 [len] [gaf]  [len] [seq] [frame] 9     × N
[N]
2 0 0 2 [string set]                     × N entries inline
1 7 Default
1 [len] [activate.wav]
1 7 Default
2 0 [help length] [help text]
[child-count]
```

For each widget type, the size of `[N]` and the structure of the string
set vary; the schemas in the source materials document each one.

### Alignment codes

Inside the string set:

| Code | Alignment |
|-----:|-----------|
| `0` | Centred |
| `1` | Left |
| `2` | Right |

For a single-state widget you'll see e.g. `2 0 6 Player`; for a 3-state
button you'll see all three states concatenated, e.g.
`2 0 0 2 0 6 Player 2 3 6 Play2r 3`.

---

## Worked example — main menu

```
2 1
2 0 0 640 480 1 1 0 0
3 255 255 255 255
1 0 0
1 0
8 MainMenu 1 2
2
1 15 TitleScreen.tsf 7 JPGTest 0 9
1 15 TitleScreen.tsf 7 JPGTest 1 9
2
2 0 0 2 0 0 2
1 0
1 0
2 0 24 #Enter#Play#Esc#Previous
6
```

Reading top to bottom:

- `2 1` — widget type 2 (header), flag 1.
- `2 0 0 640 480 1 1 0 0` — bounds at origin, 640×480, plus the four
  flag tokens.
- `3 255 255 255 255` — opaque white colour entry.
- `8 MainMenu 1 2` — control name "MainMenu" (8 chars), trailing `1 2`.
- The two `TitleScreen.tsf JPGTest` entries are the background image
  (two duplicate references — the engine wants both).
- `2 0 24 #Enter#Play#Esc#Previous` — keybindings: `Enter` triggers
  the control named "Play", `Esc` triggers "Previous".
- `6` — the form contains 6 child widgets, which follow immediately.

### TSF vs GAF backgrounds

The header widget supports two background sources:

- **`.tsf`** — a thin JPG carrier. TA:K accepts JPEGs via this wrapper
  (the actual TAF/TSF binary format hasn't been fully reverse-engineered
  publicly).
- **`.gaf`** — the standard TA: Kingdoms animation. The header
  references a sequence inside the GAF; the engine plays it as the
  background.

Either way, the format requires the image entry to be listed *twice*
back-to-back; only the second copy actually renders. This is a known
quirk.

---

## Gotchas

> [!WARNING]
> **A `.gui` file has no checksum and no recovery markers.** A single
> miscounted child-count token will silently shift every subsequent
> widget. The engine will load the file (it doesn't validate
> structure) but you'll see widgets in the wrong places, fail to find
> control names, or end up with phantom buttons.

- **Whitespace is not significant beyond delimiting tokens.** Cavedog's
  shipped files use both spaces and tabs; treat any whitespace run as
  a single separator.
- **Child counts must be exact.** A frame widget (type 9) ending with
  `4` claims the next four top-level widgets as children. Get the
  number wrong and the rest of the form fragments.
- **Listbox and scrollbar widgets are essentially empty templates** in
  the shipped files — the engine fills them at runtime from script
  state. There's no point trying to populate them statically.
- **TA:K's `-disablecavedogverification` command-line flag is required**
  to load most modded `.gui` files. Without it the engine will reject
  any file whose hash doesn't match an embedded list.
- **Some files crash when unpacked, others crash when packed.** The
  format is itself stable; the engine's loader has divergent behaviour
  between virtual filesystem layers and direct directory access. When
  modding, test both states.

---

## See also

- [GAF](gaf.md) — `.taf` animations are referenced throughout `.gui`
  files.
- [PCX](pcx.md) — the palette-carrier convention TA:K uses for `.taf`.
- The TA:K format-challenges notes in this repo's source materials —
  practical pitfalls when porting TA assets to TA:K.
- [Glossary](glossary.md).
