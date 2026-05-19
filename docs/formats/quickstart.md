# Quickstart — Five Things to Try Right Now

> Bought TA on GoG last week. Installed kbot five minutes ago. Don't
> know where to start? Try these five commands — each one takes under
> a minute and shows off a different format.
>
> All assume your TA install is registered as a kbot context (see
> [`kbot ctx`](../../README.md#kbot-ctx--working-directory-contexts)):
>
> ```bash
> kbot ctx add /path/to/total-annihilation --alias ta --game totala
> ```

---

## 1. Browse every file the game ships, in a web browser

```bash
kbot mount --server
```

Opens at <http://localhost:8090>. Click around — you can preview
TNTs, GAFs, PCXs, 3DOs, and FNTs without leaving the browser. COB
scripts get syntax highlighting and a control-flow viewer. TDF/FBI/OTA
files render as collapsible section trees.

Why bother: every other command in this guide is a focused subset of
what the explorer does. Start here, then drop to the CLI when you want
to script something.

---

## 2. Render a campaign map

```bash
kbot tnt preview "maps/sub hunting.tnt" -t /tmp/sub-hunting.png
open /tmp/sub-hunting.png      # macOS — use `xdg-open` on Linux
```

Composites feature sprites (trees, rocks, metal patches) on top of the
tile mosaic and draws numbered start-position markers from the sister
`.ota`. The 1.7 MB PNG it produces is a much richer view than the
embedded 252×252 minimap.

See [tnt.md](tnt.md) for the format details — every byte goes
somewhere.

---

## 3. See what a unit *actually does*

Decompile its compiled bytecode back to readable BOS source:

```bash
kbot cob decompile scripts/armkrog.cob | head -80
```

…that's the Krogoth's animation script. Walk cycle, weapon recoil,
death sequence — all in there. Disassemble for opcode-level detail:

```bash
kbot cob disassemble scripts/armkrog.cob -s Walk -a
```

The `-a` flag draws ASCII arrows between matching `JUMP` /
`JUMP_IF_FALSE` instructions, so the loop structure is visible at a
glance.

See [cob.md](cob.md), including the [full opcode
reference](cob.md#appendix-a--full-opcode-reference) and the
[`get_unit_value` port table](cob.md#appendix-b--get_unit_value-port-table).

---

## 4. Extract a single file from any archive

Without flattening the whole game:

```bash
kbot hpi extract totala1.hpi -p "units/ARMCOM.FBI" -t /tmp/out
cat /tmp/out/units/ARMCOM.FBI | head
```

`-p` accepts glob patterns: `-p "units/*.fbi"` pulls every FBI;
`-p "*.bos"` grabs every script source. The destination directory is
created if needed.

When you don't even know which archive has the file, ask the resolver:

```bash
kbot mcp --game-data $(kbot ctx path) &     # if MCP is configured
# or use the web UI's search box
```

See [hpi.md](hpi.md) — including a full byte-by-byte
[hex walk](hpi.md#appendix--full-hex-walk-of-afarkufo) of a small
archive.

---

## 5. Dump the canonical TA palette to a PNG you can keep

```bash
kbot pal swatch palettes/palette.pal -o /tmp/ta-palette.png --cell 24
open /tmp/ta-palette.png
```

16 × 16 grid of every colour in the game. Useful as a quick reference
when you're working on a unit skin or trying to pick a HUD colour
index. The hatched cell in the top-left is index 0 — the engine-wide
transparent sentinel.

See [pal.md](pal.md), and [pcx.md](pcx.md) for how TA: Kingdoms
distributes palettes through 1×1 PCX carriers.

---

## What next?

- **Mod a unit** — follow the [modding tutorial](modding.md) to ship a
  custom Arm Flash variant in ~20 minutes.
- **Understand the file zoo** — start at the [format reference
  index](README.md).
- **Build a tool** — every format has a Go API. Each format page's
  "Try it yourself" callout shows the `formats/<x>` import path.
- **Hook AI assistants up** — `kbot mcp` exposes everything above to
  Claude Code, Claude Desktop, Cursor, etc. via MCP. See the
  [MCP section in the README](../../README.md#kbot-mcp--model-context-protocol-server).
