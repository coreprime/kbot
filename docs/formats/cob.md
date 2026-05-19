# COB / BOS — Unit Scripting Bytecode

> Every unit in Total Annihilation runs a **script** that animates its
> pieces, emits weapon flashes, plays sound effects, and responds to
> game events. The source language is **BOS** ("Basic Object Script");
> the compiled bytecode the engine actually runs is **COB** ("Cobble"
> — Cavedog's pun for "compiled BOS"). One file per unit, named after
> the unit's `ObjectName` from its FBI.

> [!TIP]
> **Try it yourself.**
> ```bash
> # Decompile a unit's bytecode back to readable BOS
> kbot cob decompile scripts/ARMCOM.cob
>
> # Disassemble to opcode-level assembly with control-flow arrows
> kbot cob disassemble scripts/ARMCOM.cob -a
>
> # Lint a whole directory for common script issues
> kbot cob lint scripts/ -q
>
> # Round-trip the entire scripts/ tree to verify byte-perfect compile
> kbot cob roundtrip scripts/
> ```
> See the CLI [`kbot cob` reference](../../README.md#kbot-cob--cobbos-scripting)
> for every flag (and the full lint-rules table).
>
> **From Go.** Use [`formats/scripting`](../../formats/scripting/cob.go):
> ```go
> import "github.com/coreprime/kbot/formats/scripting"
>
> cob, _ := scripting.LoadFromFile("scripts/ARMCOM.cob")
> fmt.Printf("%d scripts, %d pieces\n", cob.NumScripts, cob.NumPieces)
> for i, name := range cob.ScriptNames {
>     fmt.Printf("  [%d] %s\n", i, name)
> }
> ```

---

## Two languages, one file format

| Stage | Format | Tooling |
|-------|--------|---------|
| Source | **BOS** — C-like, structured | Hand-written; Switeck's Scriptor; `kbot cob decompile` round-trips from COB |
| Compiled | **COB** — stack-based bytecode | Loaded by the engine; produced by Scriptor or `kbot cob compile` |

The engine only ever sees COB. BOS is a convenience for human authors;
when you "edit a unit's script" you're really editing the BOS source,
recompiling to COB, and shipping the COB in the unit's add-on `.ufo`.

A minimal example:

```c
// armcom.bos — fragment from the Arm Commander
piece base, pelvis, lthigh, lleg;

#define SIG_WALK 2

Create() {
    hide pelvis;
    set-signal-mask SIG_WALK;
}

Walk() {
    set-signal-mask SIG_WALK;
    while (1) {
        turn lthigh to x-axis  [-25] speed [50];
        turn lleg   to x-axis  [50]  speed [100];
        wait-for-turn lthigh around x-axis;
        sleep 100;
    }
}
```

`kbot cob compile` lowers this into a binary blob. `kbot cob
disassemble -a` shows the opcode stream side-by-side with control-flow
arrows; `kbot cob decompile` does the reverse, recovering BOS that
*almost always* round-trips byte-identical (`kbot cob roundtrip`
validates this across the entire game catalogue).

---

## COB on-disk layout

> [!IMPORTANT]
> **Two dialects.** This section describes **COB v4**, the dialect
> *Total Annihilation* ships. *TA: Kingdoms* uses **COB v6**
> (`VersionSignature == 6`), which keeps everything below but extends
> the header by 8 bytes and inserts an additional command-string
> offset table after the piece-name array. See [TA: Kingdoms — COB v6
> deltas](#ta-kingdoms--cob-v6-deltas) for the v6 specifics; the
> opcode list applies to both with the additional TAK-only opcodes
> documented in [Appendix C](#appendix-c--ta-kingdoms-opcodes).

```c
typedef struct {                          // 44-byte header (11 × uint32)
    uint32 VersionSignature;              // 4 for TA, 6 for TA: Kingdoms
    uint32 NumScripts;                    // Number of functions (Create, Killed, …)
    uint32 NumPieces;                     // Number of named pieces
    uint32 LengthOfScripts;               // Total code size, in DWORDs
    uint32 NumberOfStaticVars;            // Static-variable count
    uint32 UKZero;                        // Always 0 in retail bytecode; purpose unknown
    uint32 OffsetToScriptCodeIndexArray;  // → uint32 × NumScripts: code-index per script
    uint32 OffsetToScriptNameOffsetArray; // → uint32 × NumScripts: absolute offsets into string pool
    uint32 OffsetToPieceNameOffsetArray;  // → uint32 × NumPieces: absolute offsets into string pool
    uint32 OffsetToScriptCode;            // → packed uint32 opcode stream
    uint32 OffsetToNameArray;             // Byte just past the piece-name offset array (= sound-name offset table start for TAK v6, or string-pool start for TA v4)
} COBHeader;
```

> [!NOTE]
> The canonical field names match Scriptor's `HEADER_COB` struct. Earlier
> kbot revisions called `LengthOfScripts` / `NumberOfStaticVars` /
> `UKZero` / `OffsetToNameArray` "Unknown0/1/2/3" — same offsets, just
> with the documented identities now applied.

Then follow, in this layout:

```
┌─ Script code ─────────────────────────────┐  uint32 opcodes/operands, packed
├─ Script code-index table ─────────────────┤  uint32[NumScripts] — *not* byte offsets
├─ Script name offset table ────────────────┤  uint32[NumScripts]
├─ Piece name offset table ─────────────────┤  uint32[NumPieces]
└─ String pool ─────────────────────────────┘  NUL-terminated names, in order
```

### Resolving a script

The code-index table contains **`uint32` word offsets**, not byte
offsets. To find the bytecode for script number `i`:

```c
uint32 first_instr_word = ScriptCodeIndexArray[i];
uint32 byte_offset      = OffsetToScriptCode + first_instr_word * 4;
```

The script ends where the next script begins (or at the start of the
index table, for the last script).

> [!IMPORTANT]
> **String offsets in the name tables are *absolute file offsets*, not
> string-pool-relative**. Cavedog's tooling never moved the string pool
> around so this didn't matter in practice; if you reorganise a COB by
> hand, every offset has to be updated.

---

## The opcode stream

COB is a **stack-based virtual machine**. Most opcodes pop arguments
from a per-script data stack, do their thing, and push a result back.
Some opcodes have inline operands (jump targets, piece numbers).

Each opcode is one `uint32` with the layout:

```
       MSB                          LSB
  ┌─────────┬─────────┬─────────┬─────────┐
  │   0x10  │ family  │ op      │ flags   │
  └─────────┴─────────┴─────────┴─────────┘
```

The high byte is always `0x10`; family/op/flags vary per opcode. kbot's
[`scripting/opcodes.go`](../../formats/scripting/opcodes.go) is the
authoritative catalogue, lifted directly from the in-game implementation
plus the Saruman & Switeck reverse-engineering notes.

### Opcode families

| Family | Examples | Notes |
|--------|----------|-------|
| `0x100x` | `MOVE`, `TURN`, `SPIN`, `SHOW`, `HIDE`, `EMIT_SFX` | Piece animation. Piece# and axis# follow inline. |
| `0x101x` | `WAIT_FOR_TURN`, `WAIT_FOR_MOVE`, `SLEEP` | Async barriers — the script yields until the condition is met. |
| `0x102x` | `PUSH_CONSTANT`, `PUSH_LOCAL_VAR`, `PUSH_STATIC`, `POP_*` | Stack manipulation. |
| `0x103x` | `ADD`, `SUB`, `MUL`, `DIV`, `MOD`, `BITWISE_*` | Arithmetic & bitwise. |
| `0x104x` | `RAND`, `GET_UNIT_VALUE`, `GET` | Engine queries. |
| `0x105x` | `<`, `<=`, `>`, `>=`, `==`, `!=`, `&&`, `\|\|`, `^^`, `!` | Comparisons & logical ops. |
| `0x106x` | `START_SCRIPT`, `CALL_SCRIPT`, `JUMP`, `RETURN`, `JUMP_IF_FALSE`, `SIGNAL`, `SET_SIGNAL_MASK` | Control flow and concurrency. |
| `0x107x` | `EXPLODE`, `PLAY_SOUND` | Special effects. |
| `0x108x` | `SET_VALUE`, `ATTACH_UNIT`, `DROP_UNIT` | Engine mutations. |

A small but representative sampler:

```
0x10021001 PUSH_CONSTANT  <value>      ( -- v )
0x10021002 PUSH_LOCAL_VAR <var#>       ( -- v )
0x10023002 POP_LOCAL_VAR  <var#>       ( v -- )
0x10033000 MUL                         ( a b -- a*b )
0x10051000 LESS_THAN                   ( a b -- a<b )
0x10066000 JUMP_IF_FALSE <byteOffset>  ( v -- )    pops; falls through if v != 0
0x10064000 JUMP          <byteOffset>  ( -- )
0x10065000 RETURN                      ( v -- )    pops the return value
0x10001000 MOVE          <piece> <axis> ( speed distance -- )
0x10003000 SPIN          <piece> <axis> ( speed -- )
0x1000F000 EMIT_SFX      <piece>       ( flags -- )
0x10068000 SET_SIGNAL_MASK              ( mask -- )
```

> [!NOTE]
> **Jump offsets are *byte* offsets relative to the start of the script
> code section** (not the current instruction). `JUMP 0x4C` means "jump
> to `OffsetToScriptCode + 0x4C`". The disassembler's `-a` flag draws
> arrows between matching instructions to make this obvious.

---

## Concurrency model

A unit can have many scripts running concurrently — Walk, Aim,
SmokeUnit, MoveWatcher, etc. They're cooperatively scheduled:

- **`sleep <ticks>`** yields for N ticks (1/30 s each).
- **`wait-for-turn <piece> around <axis>`** yields until that piece
  finishes its current `turn` animation. Same for `wait-for-move`.
- **`signal <n>`** kills every script whose `signal_mask & n != 0`.
- **`set-signal-mask <n>`** declares which signals the current script
  is interested in.

The signal mask is how scripts implement preemption: `MoveWatcher` sets
mask `SIG_MOVE` and watches velocity; when the unit stops moving it
sends `SIG_MOVE`, killing the walk animations cleanly before starting
the idle pose.

> [!WARNING]
> **`SET_SIGNAL_MASK` only registers interest — it does not kill
> anything.** Sending `signal X` is what stops scripts with mask `X` set.
> The `signal-never-signalled` lint rule in `kbot cob lint` catches
> scripts that set a mask nobody ever signals (which is almost always
> a bug).

### How preemption actually plays out

A common pattern: `MoveUnit` triggers a `Walk` animation script; when
movement stops the engine sends `SIG_MOVE` to clean up cleanly before
`Idle` starts. The sequence:

```text
   Engine                 MoveUnit script        Walk script        Idle script
     │                          │                     │                  │
     │  unit ordered to move    │                     │                  │
     ├─ start-script MoveUnit──▶│                     │                  │
     │                          ├─ set-signal-mask    │                  │
     │                          │   SIG_MOVE          │                  │
     │                          ├─ start-script Walk─▶│                  │
     │                          │                     ├─ set-signal-mask │
     │                          │                     │   SIG_MOVE       │
     │                          │                     │ (loops:          │
     │                          │                     │   turn pieces,   │
     │                          │                     │   sleep, repeat) │
     │                          │                     │                  │
     │  movement completes      │                     │                  │
     ├─ engine sets velocity=0  │                     │                  │
     │                          ├─ signal SIG_MOVE ──┐│                  │
     │                          │                    ││                  │
     │   ◀─── KILLED ──────────────────────────────  ◀┤                  │
     │   ◀─── KILLED ──────────┤                     │                  │
     │                                                                   │
     ├─ start-script Idle ─────────────────────────────────────────────▶│
     │                                                                   │ (loops)
```

Three things to notice:

1. **Both scripts that set `SIG_MOVE` are killed** when the signal
   fires — including `MoveUnit` itself (it doesn't matter; its work is
   done).
2. The signalling script (`MoveUnit`) survives long enough to **send
   the signal** before being killed; the runtime checks masks *after*
   the `signal` opcode returns.
3. `Idle` doesn't set `SIG_MOVE`, so the next `signal SIG_MOVE` won't
   touch it.

---

## Worked example — `cortruck.cob` (Core Construction Truck)

`kbot cob decompile scripts/cortruck.cob`:

```c
piece base;

SmokeUnit() {
    var local_0, local_1, local_2;

    while (get BUILD_PERCENT_LEFT) { sleep 400; }

    while (1) {
        local_0 = get HEALTH;
        if (local_0 < 66) {
            local_2 = (256 | 2);
            if (rand(1, 66) < local_0) { local_2 = (256 | 1); }
            emit-sfx local_2 from base;
        }
        local_1 = (local_0 * 50);
        if (local_1 < 200) { local_1 = 200; }
        sleep local_1;
    }
    return 0;
}

Create() { return 0; }

Killed() {
    var severity;
    if (severity <= 25) { explode base type (32 | 256); return 0; }
    if (severity <= 50) { explode base type (32 | 256); return 0; }
    if (severity <= 99) { explode base type (32 | 256); return 0; }
    explode base type (32 | 256);
}
```

The corresponding disassembly (`kbot cob disassemble -a -s SmokeUnit`)
shows the actual opcode stream, with `JUMP_IF_FALSE`/`JUMP` arrows
threaded through the `while`/`if` bodies — useful when the decompiler
output is ambiguous.

---

## Linting

`kbot cob lint` ships 17 rules drawn from real-world bugs in Cavedog's
own scripts and from community-submitted mod patches. The full
catalogue:

| Rule | Severity | Catches |
|------|----------|---------|
| `unused-piece` | warning | Piece declared but never used in any script. |
| `unused-static` / `unused-local` | warning | Variable allocated but never read. |
| `always-true` / `dead-code` | info / warning | `if(1)` / `while(0)`. |
| `long-function` / `high-complexity` | warning | > 100 instructions or > 15 cyclomatic complexity. |
| `invalid-call` | error | `call-script` to a non-existent function. |
| `speed-zero` | warning | `move`/`turn` with `speed <0>` — animation never completes. |
| `empty-function` | info | Function body is only `return 0`. |
| `duplicate-animation` | warning | Two identical animation commands back-to-back. |
| `sleep-only-guard` | info | `if` block contains nothing but `sleep`. |
| `duplicate-if` | info | Two `if`s with the same condition in a row. |
| `raw-signal` | info | `signal 4` instead of `signal SIG_AIM`. |
| `unnamed-global` | info | `global_3` instead of a named static. |
| `signal-never-signalled` | warning | Script masks a signal nobody emits. |
| `recursive-call` | warning | `call-script` cycle. |

The full rule descriptions are in the kbot README. The decompiler
deliberately preserves the original variable and piece numbering so that
a decompile→lint→fix→compile cycle highlights mods needing maintenance.

---

## Gotchas

> [!WARNING]
> **`call-script` opcode is `0x10062000`, not `0x10063000`** as the
> original Cavedog "glossary" leak documents. The original document was
> drafted against an early build; retail TA uses the value kbot's
> `opcodes.go` defines. If your decompiler is producing nonsensical
> `call-script` output, this is probably why.

- **All offsets in the COB header are *absolute file offsets***, but the
  `ScriptCodeIndexArray` entries are *word offsets within the code
  section*. Easy to confuse them.
- **Piece numbers in opcodes are indices into the piece name table**,
  not strings. The COB carries the names as a string pool; the runtime
  uses indices for speed.
- **`get UNIT_VALUE` opcodes vary subtly between TA and TA: Kingdoms.**
  TA: Kingdoms added value IDs for magic regen, command-points, etc.;
  TA's value table is more compact. kbot's decompiler currently labels
  the TA set; TAK port numbers ≥ 21 are emitted as numeric literals
  (which still round-trip through the assembler). See
  [TA: Kingdoms — COB v6 deltas](#ta-kingdoms--cob-v6-deltas) for the
  full delta.
- **Variables come in two flavours**: `local_N` (function-local stack
  slot) and `global_N` (per-unit static persisting across calls). The
  decompiler emits `local_N` / `global_N` by default; rename them in
  source for readability.
- **The Cavedog Scriptor tool occasionally inlines `CURRENT_SPEED` as a
  literal `29`**, breaking `MoveWatcher`-style scripts after a round
  trip. kbot's decompiler restores the symbolic name; if you must
  round-trip through Scriptor, parenthesise: `(get CURRENT_SPEED) > 5`.

---

## Typical sizes

| Asset | Range observed in Cavedog `scripts/*.cob` |
|-------|-------------------------------------------|
| File size | 0.5 KB – 25 KB |
| Header overhead | always 44 bytes |
| Scripts per unit | 3 – 30 (typical units: 5–10) |
| Pieces per unit | 3 – 80 (Krogoth ≈ 80) |
| Code section size | 300 B – 20 KB (varies wildly with complexity) |
| `armcom.cob` (commander) | ~14 KB, 30 scripts |
| `cortruck.cob` (simple unit) | ~750 B, 3 scripts |

---

## TA: Kingdoms — COB v6 deltas

> [!NOTE]
> **This section is the TA:K-only delta.** Everything above describes
> COB v4 (TA). TA: Kingdoms keeps the same stack VM, the same string
> pool, the same opcode encoding scheme, and the same script-name /
> piece-name machinery; the differences are an extended header, an
> additional string table appended after the piece-name array, and
> four new opcodes.

### v6 file layout

```
┌─ 44-byte v4 header ──────────────────────────────────┐
│ VersionSignature == 6, NumScripts, NumPieces, …      │
├─ Sub-header (8 bytes, TAK-only) ─────────────────────┤  (soundNameOffsetTableStart, soundNameCount)
├─ Script code (uint32 opcode stream) ─────────────────┤  same encoding as v4
├─ ScriptCodeIndexArray (uint32 × NumScripts) ─────────┤  unchanged
├─ ScriptNameOffsetArray (uint32 × NumScripts) ────────┤  unchanged
├─ PieceNameOffsetArray (uint32 × NumPieces) ──────────┤  unchanged
├─ SoundNameOffsetArray (uint32 × Count) ──────────────┤  TAK-only — count from sub-header[1]
└─ String pool ────────────────────────────────────────┘  script names → piece names → sound names (in that order)
```

The 8-byte **sub-header** sits between `OffsetToNameArray` (end of the
canonical 11-DWORD header at byte 44) and the start of the code
section (`OffsetToScriptCode`, typically `0x34` = 52). It carries two
little-endian uint32s:

| Field | Meaning |
|-------|---------|
| `[0]` | Absolute file offset of the sound-name offset table. Always equal to `OffsetToPieceNameOffsetArray + NumPieces × 4` — i.e. the byte just past the piece-name offset array. Redundant with the canonical layout; the writer reconstructs it. |
| `[1]` | Number of sound names in the table. Authoritative count. |

Each entry in the **sound-name offset table** is an absolute file
offset of a NUL-terminated string in the string pool — things like
`"SetMission o 1, s"`, `"create ARASWORD"`, `"ARROW10"`. The
bytecode references them by **index** (not by offset) via the
`MISSION_COMMAND` opcode (see [Appendix C](#appendix-c--ta-kingdoms-opcodes)).
The table is called the *sound-name array* because the canonical
Scriptor compiler registers strings into it via the `ADDSOUND` action;
the actual contents are engine command strings rather than audio
filenames.

### kbot's representation

[`scripting.COB`](../../formats/scripting/cob.go) carries the
sound names as a structured `[]string` field — no opaque-byte
preservation. Everything else (the sub-header values, the offset
table, the per-string offsets in the pool) is reconstructed from
this list on write:

```go
type COB struct {
    // …canonical TA fields…
    SoundNames []string // TAK-only; nil for v4
}
```

For v4 files the slice is always nil and both the sub-header and
sound-name offset table are omitted from the output.

The disassembler / decompiler emit each string as a `.sound_name`
directive so they survive a round-trip through `.coba` and `.bos`:

```
.version 6
.statics 6
.sound_name "create NPCEMEN"
.sound_name "SetMission o 1, s"
.sound_name "ARROW10"
.script Start
…
```

### New opcodes

Four opcodes appear in TAK `.cob` files that have no v4 equivalent.
Their exact game-side semantics are not documented, but their binary
layout (size + inline parameter count) was determined by disassembling
every retail TAK `.cob` — that's enough for the disassemble→assemble
round-trip to recover the original bytes verbatim. See
[Appendix C](#appendix-c--ta-kingdoms-opcodes) for the full reference.

### Round-trip status

| Pipeline | TA | TA: Kingdoms |
|----------|----|--------------|
| `disassemble → assemble` (byte-identical) | 278 / 278 ✅ | **267 / 267 ✅** |
| `decompile → compile` (byte-identical) | 278 / 278 ✅ | Simple unit scripts and many mission COBs (≈ 70 / 267) round-trip byte-perfect. The remaining failures are control-flow patterns where the decompiler's structured `if`/`while` reconstruction picks a JUMP layout that the compiler regenerates slightly differently — the bytecode is **semantically equivalent** (every TAK opcode, command string, sub-header, and the v6 version word survives), just not byte-identical. The same kind of mismatch would affect any decompile→compile cycle on a non-trivial script. |

### BOS surface for TAK extensions

The decompiler emits four pseudo-calls so TAK COBs round-trip through
BOS. The compiler accepts the same syntax. Two of them (`dont-shadow`
and `Mission-Command`) use Scriptor's canonical TAK keywords; the math
opcodes have no documented name in Scriptor (it labels them `??` and
`????`), so kbot keeps the `__tak_math_*` placeholders:

```c
// Statement-level (emitted on their own line):
dont-shadow(<piece>);                                  // DONT_SHADOW — disables shadow casting for one piece
Mission-Command("sound name", arg1, arg2, …);          // MISSION_COMMAND — engine call (statement form drops the return value)
return_val = Mission-Command("sound name", args…);     // assignment form keeps the pushed result

// Expression-level (wrap any expression; stack-neutral):
local_x = __tak_math_09(<expr>);   // TAK_MATH_09 between expr and POP
local_x = __tak_math_0b(<expr>);   // TAK_MATH_0B
```

`Mission-Command`'s first argument is the **sound name** as a quoted
string — the compiler looks it up in the sound-name table (so the
corresponding `.sound_name` directive must appear earlier in the
file). The remaining arguments are pushed onto the stack and the
engine consumes them.

Two top-of-file directives carry the rest of the v6 metadata:

```
.version 6
.sound_name "create NPCEMEN"
.sound_name "SetMission o 1, s"
.sound_name "ARROW10"
```

`.version` is always emitted (so v4 TA files round-trip identically
through the same pipeline). Each `.sound_name` is one entry in the
per-COB sound-name table; the writer rebuilds the 8-byte sub-header
and the sound-name offset table from `len(SoundNames)` and the order
the entries appear.

The TAK `STACK_ALLOC ; RETURN` epilogue every value-less `return;`
emits in v6 is handled by the compiler: `return;` lowers to
`STACK_ALLOC ; RETURN` when `.version 6`, `return <expr>;` lowers to
`<expr> ; RETURN` without a prefix (matching Cavedog's compiler).

Reproduce on your own install:

```bash
kbot ctx use kingdoms  # or wherever you registered TAK
kbot cob roundtrip
```

### Port symbols beyond port 20

TA: Kingdoms scripts use `get_unit_value` ports up to 46
(`CURRENT_SPEED`, `VETERAN_LEVEL`, magic-pool fields, etc.). kbot's
decompiler currently labels only ports 1–20 symbolically (see
[Appendix B](#appendix-b--get_unit_value-port-table)); TAK ports
≥ 21 are emitted as numeric literals. The bytecode stores them as
integers either way, so round-trips are unaffected — only the BOS
readability suffers. Adding TAK port names is tracked separately.

---

## Appendix A — Full opcode reference

Every opcode kbot's VM recognises. Source of truth is
[`formats/scripting/opcodes.go`](../../formats/scripting/opcodes.go).
**Stack notation** uses Forth-style `( before -- after )`. **Inline**
columns show how many `uint32` words follow the opcode word itself
(consumed during decode, not from the stack).

### Animation — piece manipulation (`0x100x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10001000` | `MOVE` | 2 (`piece`, `axis`) | `( speed dist -- )` | `move <piece> to <axis> <dist> speed <speed>;` |
| `0x10002000` | `TURN` | 2 (`piece`, `axis`) | `( speed dir -- )` | `turn <piece> to <axis> <dir> speed <speed>;` |
| `0x10003000` | `SPIN` | 2 (`piece`, `axis`) | `( speed -- )` | `spin <piece> around <axis> speed <speed>;` |
| `0x10004000` | `STOP_SPIN` | 2 (`piece`, `axis`) | `( decel -- )` | `stop-spin <piece> around <axis> [decel <d>];` |
| `0x10005000` | `SHOW` | 1 (`piece`) | `( -- )` | `show <piece>;` |
| `0x10006000` | `HIDE` | 1 (`piece`) | `( -- )` | `hide <piece>;` |
| `0x10007000` | `CACHE` | 1 (`piece`) | `( -- )` | `cache <piece>;` |
| `0x10008000` | `DONT_CACHE` | 1 (`piece`) | `( -- )` | `dont-cache <piece>;` |
| `0x1000B000` | `MOVE_NOW` | 2 (`piece`, `axis`) | `( pos -- )` | `move <piece> to <axis> <pos> now;` |
| `0x1000C000` | `TURN_NOW` | 2 (`piece`, `axis`) | `( angle -- )` | `turn <piece> to <axis> <angle> now;` |
| `0x1000D000` | `SHADE` | 1 (`piece`) | `( -- )` | `shade <piece>;` |
| `0x1000E000` | `DONT_SHADE` | 1 (`piece`) | `( -- )` | `dont-shade <piece>;` |
| `0x1000F000` | `EMIT_SFX` | 1 (`piece`) | `( type -- )` | `emit-sfx <type> from <piece>;` |

### Wait operations (`0x101x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10011000` | `WAIT_FOR_TURN` | 2 (`piece`, `axis`) | `( -- )` | `wait-for-turn <piece> around <axis>;` |
| `0x10012000` | `WAIT_FOR_MOVE` | 2 (`piece`, `axis`) | `( -- )` | `wait-for-move <piece> along <axis>;` |
| `0x10013000` | `SLEEP` | 0 | `( ticks -- )` | `sleep <ticks>;` |

### Stack manipulation (`0x102x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10021000` | `PUSH_IMMEDIATE` | 1 (`value`) | `( -- v )` | (compiler) |
| `0x10021001` | `PUSH_CONSTANT` | 1 (`value`) | `( -- v )` | `<literal>` in any expression |
| `0x10021002` | `PUSH_LOCAL_VAR` | 1 (`var#`) | `( -- v )` | `local_N` in any expression |
| `0x10021004` | `PUSH_STATIC` | 1 (`var#`) | `( -- v )` | `global_N` in any expression |
| `0x10021008` | `CREATE_LOCAL` | 0 | `( -- )` | (implicit — emitted by `var x;`) |
| `0x10022000` | `STACK_ALLOC` | 0 | `( -- )` | (implicit — function prologue) |
| `0x10023002` | `POP_LOCAL_VAR` | 1 (`var#`) | `( v -- )` | `local_N = expr;` |
| `0x10023004` | `POP_STATIC` | 1 (`var#`) | `( v -- )` | `global_N = expr;` |
| `0x10024000` | `POP_STACK` | 0 | `( v -- )` | (discards an expression's result) |

### Arithmetic (`0x103x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10031000` | `ADD` | 0 | `( a b -- a+b )` | `a + b` |
| `0x10032000` | `SUB` | 0 | `( a b -- a-b )` | `a - b` |
| `0x10033000` | `MUL` | 0 | `( a b -- a*b )` | `a * b` |
| `0x10034000` | `DIV` | 0 | `( a b -- a/b )` | `a / b` |
| `0x10035000` | `BITWISE_AND` | 0 | `( a b -- a&b )` | `a & b` |
| `0x10036000` | `BITWISE_OR` | 0 | `( a b -- a\|b )` | `a \| b` |
| `0x10037000` | `MOD` | 0 | `( a b -- a%b )` | `a % b` |
| `0x10038000` | `BITWISE_XOR` | 0 | `( a b -- a^b )` | `a ^ b` |
| `0x1003A000` | `BITWISE_NOT` | 0 | `( a -- ~a )` | `~a` |

### Engine queries (`0x104x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10041000` | `RAND` | 0 | `( low high -- rnd )` | `rand(low, high)` |
| `0x10042000` | `GET_UNIT_VALUE` | 0 | `( port -- value )` | `get <PORT_NAME>` |
| `0x10043000` | `GET` | 0 | `( ... -- value )` | `get <variant>` |

See [Appendix B](#appendix-b--get_unit_value-port-table) for the port
catalogue.

### Comparison & logical (`0x105x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10051000` | `LESS_THAN` | 0 | `( a b -- a<b )` | `a < b` |
| `0x10052000` | `LESS_OR_EQUAL` | 0 | `( a b -- a<=b )` | `a <= b` |
| `0x10053000` | `GREATER_THAN` | 0 | `( a b -- a>b )` | `a > b` |
| `0x10054000` | `GREATER_EQUAL` | 0 | `( a b -- a>=b )` | `a >= b` |
| `0x10055000` | `EQUAL` | 0 | `( a b -- a==b )` | `a == b` |
| `0x10056000` | `NOT_EQUAL` | 0 | `( a b -- a!=b )` | `a != b` |
| `0x10057000` | `LOGICAL_AND` | 0 | `( a b -- a&&b )` | `a AND b` |
| `0x10058000` | `LOGICAL_OR` | 0 | `( a b -- a\|\|b )` | `a OR b` |
| `0x10059000` | `LOGICAL_XOR` | 0 | `( a b -- a^^b )` | `a XOR b` |
| `0x1005A000` | `LOGICAL_NOT` | 0 | `( a -- !a )` | `NOT a` |

### Control flow & concurrency (`0x106x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10061000` | `START_SCRIPT` | 2 (`script#`, `argc`) | `( args… -- )` | `start-script Foo(a, b);` |
| `0x10062000` | `CALL_SCRIPT` | 2 (`script#`, `argc`) | `( args… -- )` | `call-script Foo(a, b);` |
| `0x10064000` | `JUMP` | 1 (`offset`) | `( -- )` | (compiler — `goto`, loops) |
| `0x10065000` | `RETURN` | 0 | `( v -- )` | `return v;` |
| `0x10066000` | `JUMP_IF_FALSE` | 1 (`offset`) | `( v -- )` | (compiler — `if`/`while`) |
| `0x10067000` | `SIGNAL` | 0 | `( mask -- )` | `signal <mask>;` |
| `0x10068000` | `SET_SIGNAL_MASK` | 0 | `( mask -- )` | `set-signal-mask <mask>;` |

`offset` for `JUMP` / `JUMP_IF_FALSE` is a **byte offset** relative to
`OffsetToScriptCode`, not relative to the current instruction.

### Effects (`0x107x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10071000` | `EXPLODE` | 1 (`piece`) | `( type -- )` | `explode <piece> type <type>;` |
| `0x10072000` | `PLAY_SOUND` | 1 (`vol`) | `( sound -- )` | `play-sound <sound> vol <vol>;` |

### Set operations (`0x108x`)

| Opcode | Mnemonic | Inline | Stack effect | BOS syntax |
|--------|----------|:------:|--------------|------------|
| `0x10082000` | `SET_VALUE` | 0 | `( port value -- )` | `set <PORT_NAME> to <value>;` |
| `0x10083000` | `ATTACH_UNIT` | 1 (`piece`) | `( unit -- )` | `attach-unit <unit> to <piece>;` |
| `0x10084000` | `DROP_UNIT` | 0 | `( unit -- )` | `drop-unit <unit>;` |

### Opcode encoding

Every opcode word is `0x10CCSSFF`, where:

- `CC` = the **category** byte (animation, math, control flow, …).
- `SS` = the **sub-command** nibble in the high nibble of the second
  byte from the top.
- `FF` = the **flags** byte. Most opcodes use `0x00`; the `PUSH_*` and
  `POP_*` family encode source-of-value here (`0x01` = constant,
  `0x02` = local, `0x04` = static, `0x08` = create-local).

Unknown opcodes are rendered as `UNKNOWN_0x10xxxxxx` by the
disassembler; if you find one in a real file, please open an issue
with the COB sample.

---

## Appendix B — `get_unit_value` port table

The 20 ports kbot's decompiler currently labels symbolically. Real TA
has ~80; TA: Kingdoms adds another ~15 for magic-related quantities.
Anything above port 20 is rendered as a numeric literal in the
decompiler output today.

| Port | Symbolic name | Returns | Notes |
|-----:|---------------|---------|-------|
| 1 | `ACTIVATION` | bool | Is the unit's "active" toggle on (radar, jammer, fortifications)? |
| 2 | `STANDINGMOVEORDERS` | enum | `0` = hold position, `1` = manoeuvre, `2` = roam. |
| 3 | `STANDINGFIREORDERS` | enum | `0` = hold fire, `1` = return fire, `2` = fire at will. |
| 4 | `HEALTH` | 0–100 | Percentage of `MaxDamage` remaining. |
| 5 | `INBUILDSTANCE` | bool | Is the unit currently extending nano-lathes? |
| 6 | `BUSY` | bool | Is the unit currently busy with an order? |
| 7 | `PIECE_XZ` | packed | Combined X/Z of a piece (encoded). Used for projectile aiming. |
| 8 | `PIECE_Y` | int | Y-coordinate of a piece relative to the unit origin. |
| 9 | `UNIT_XZ` | packed | Combined X/Z of the unit. |
| 10 | `UNIT_Y` | int | Y-coordinate of the unit. |
| 11 | `UNIT_HEIGHT` | int | Height above terrain. |
| 12 | `XZ_ATAN` | int | `atan2` between two XZ-encoded values (for aim turrets). |
| 13 | `XZ_HYPOT` | int | Hypotenuse between two XZ-encoded values. |
| 14 | `ATAN` | int | `atan2(y, x)` of two pushed values. |
| 15 | `HYPOT` | int | `hypot(x, y)`. |
| 16 | `GROUND_HEIGHT` | int | Terrain elevation at the unit's position. |
| 17 | `BUILD_PERCENT_LEFT` | 0–100 | Used by `SmokeUnit` to know construction progress. `0` once built. |
| 18 | `YARD_OPEN` | bool | For yard-map buildings: are the doors open? |
| 19 | `BUGGER_OFF` | bool | Set by the engine when the unit needs to move out of the way. |
| 20 | `ARMORED` | bool | Is the unit's armoured stance enabled (Bulldog, Goliath, etc.)? |

Higher ports include `CURRENT_SPEED` (29 — famously inlined as a
literal by the Cavedog Scriptor; see Gotchas above), `MAX_ID`,
`UNIT_TEAM`, `UNIT_BUILD_PERCENT`, `BUILDER`, `UNIT_ALLIED`, and many
more. The full list lives in Cavedog's internal documentation; the
community wiki at the TAUniverse forums has the most comprehensive
public catalogue.

TA: Kingdoms extends the port range. The TAK-only ports kbot recognises
(decompiler renders the symbolic name; compiler accepts it as input)
are taken from Scriptor's `[UNITVLAUES]` table:

| Port | Symbol | Notes |
|-----:|--------|-------|
|   21 | `WEAPON_AIM_ABORTED` | Set when a weapon's aim solution is cancelled. |
|   22 | `WEAPON_READY` | Weapon has reloaded and is ready to fire. |
|   23 | `WEAPON_LAUNCH_NOW` | Engine has fired the weapon. |
|   26 | `FINISHED_DYING` | Death animation has completed. |
|   27 | `ORIENTATION` | Unit's facing direction. |
|   28 | `IN_WATER` | Unit is in water. |
|   29 | `CURRENT_SPEED` | Current movement speed (shared with TA — Scriptor numbers it the same here). |
|   31 | `MAGIC_DEATH` | Unit died from magic damage. |
|   32 | `VETERAN_LEVEL` | Veterancy tier. |
|   34 | `ON_ROAD` | Unit is on a road tile. |

---

## Appendix C — TA: Kingdoms opcodes

> [!NOTE]
> **TA:K-only opcodes.** None of these appear in retail TA `.cob`
> files. `DONT_SHADOW` and `MISSION_COMMAND` use the canonical
> mnemonics from Scriptor (Switeck's TAK-aware compiler/decompiler);
> the math ops have no documented semantics — Scriptor labels them
> `??` and `????`, so kbot keeps the `TAK_MATH_09` / `TAK_MATH_0B`
> placeholders and treats them as stack-neutral pseudo-ops, which is
> consistent with every retail call site.

| Opcode | Mnemonic | Inline | Sites in retail TAK | Notes |
|--------|----------|:------:|--------------------:|-------|
| `0x1000A000` | `DONT_SHADOW` | 1 (`piece`) | 66 | Disables shadow casting for a single piece. Sits in the animation category next to `DONT_SHADE` (`0x1000E000`) — kbot earlier called this `TAK_ANIM_0A`. Same on-disk shape as the other ANIM_* ops: 4-byte opcode + one `piece` DWORD. BOS keyword: `dont-shadow <piece>;`. |
| `0x10039000` | `TAK_MATH_09` | 0 | 264 | Math-category op, 4 bytes total. Always observed in a `<expr>` … `TAK_MATH_09` `POP_*` pattern — kbot wraps the inner expression with `__tak_math_09(...)` so the round trip reinstates the opcode. |
| `0x1003B000` | `TAK_MATH_0B` | 0 | 66 | Same shape as `TAK_MATH_09`; sits one slot past `BITWISE_NOT` (`0x1003A000`). |
| `0x10073000` | `MISSION_COMMAND` | 2 (`soundNameIdx`, `argCount`) | 3,885 | Engine command call. The first inline DWORD is an index into the COB's `SoundNames` table; the second is the number of values to pop off the stack as arguments. The opcode pushes a single result back onto the stack (typically dropped via a following `POP_STACK` or stored via `POP_STATIC`/`POP_LOCAL_VAR`). By far the most common TAK-only opcode. BOS keyword: `Mission-Command("name", args…)` — matches Scriptor's canonical surface. |

### Encoding (recap)

Every COB opcode word is `0x10CCSSFF` where `CC` is the category and
`SS` is the sub-command — these TAK opcodes simply occupy
previously-unused `CC:SS` slots inside the existing categories rather
than introducing a new category byte. `DONT_SHADOW` lives in the
animation category alongside `DONT_CACHE`/`DONT_SHADE`, and
`MISSION_COMMAND` in the effect category alongside `EXPLODE` and
`PLAY_SOUND`.

> [!TIP]
> **Cross-reference real bytecode.**
> ```bash
> kbot ctx use tak-30bb-flat
> kbot cob disassemble scripts/araat.cob -a | grep -E 'DONT_SHADOW|MISSION|TAK_MATH'
> ```

---

## Live examples in the reference catalogue

Real units exercising the format extremes — open these to see actual
script complexity rather than worked-in-text examples:

- [`CORKROG` — Krogoth (Core)](https://github.com/coreprime/reference-ta/blob/main/ta-units.md) —
  one of the largest COBs in the game (~25 KB, 30+ scripts, complex
  multi-piece animations).
- [`ARMCOM` — Arm Commander](https://github.com/coreprime/reference-ta/blob/main/ta-units.md) —
  representative "rich" unit: walk/aim/idle/build cycles, multiple
  weapons, D-gun handling.
- [`CORTRUCK` — Construction Truck](https://github.com/coreprime/reference-ta/blob/main/ta-units.md) —
  near-minimal COB used as the walkthrough on this page (3 scripts:
  `SmokeUnit`, `Create`, `Killed`).
- [`ARMSAM` — Samson](https://github.com/coreprime/reference-ta/blob/main/ta-units.md) —
  good example of a turret unit (`turret1` rotate-to-aim, recoil
  animation, `wait-for-turn` synchronisation).

Decompile any locally with `kbot cob decompile scripts/<name>.cob`
once a kbot context is set.

---

## See also

- [3DO](3do.md) — the piece names referenced by COB scripts live in
  the unit's `.3do`.
- [FBI](tdf.md) — the unit's metadata file. `ObjectName` there ties
  the COB to a 3DO; `Sounds` define the audio bank the script can play.
- The kbot CLI's [`cob lint`](../../README.md#kbot-cob--cobbos-scripting)
  rules table.
- [Glossary](glossary.md) — *piece*, *axis*, *signal mask*, *tick*.
