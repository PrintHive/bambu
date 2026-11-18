# @printhive/bambu

A type-first Bambu Lab printer client for [Effect](https://effect.website), with a built-in emulator, on Bun and Node.js.

It is in early development, and nothing is published yet. The design lives in PrintHive/hive under `docs/design/printhive-bambu`.

It builds on [@printhive/mqtt](https://github.com/PrintHive/mqtt), [@printhive/lanscout](https://github.com/PrintHive/lanscout), and [@printhive/bambu-models](https://github.com/PrintHive/bambu-models).

## Clean room

Everything here comes from PrintHive's own scrubbed captures and from permissively licensed or factual sources, such as pybambu (MIT) and OpenBambuAPI. Never copy from or derive from AGPL or GPL projects, such as BambuStudio or OrcaSlicer. Those may be used only to cross-check.

## Develop

```sh
bun install
bun run check
bun run build
```

### Tapes

A tape is a captured, scrubbed session with a real printer, stored as JSON Lines in `test/fixtures/tapes/`. Tapes are the truth: `test/tape-replay.test.ts` replays each one through `reduce` with no emulator involved, and checks the state against values read from the capture.

This repository is public, so a capture is scrubbed before it is committed:

```sh
bun scripts/scrub-tape.ts capture.jsonl test/fixtures/tapes/p1s-01.09.00.00/idle-2026-09-18.jsonl
```

The scrubber replaces serials with `<prefix>MOCK<counter>` and cloud task, project and profile ids with small counters, consistently across a tape. IPv4 and IPv6 addresses become documentation addresses (RFC 5737, RFC 3849), and URLs become a placeholder. It blanks MAC addresses, Wi-Fi names, hostnames, device and user names, credentials, RFID identifiers and print job names. Version fields keep their versions, and every other wire value is kept. `test/tape-privacy.test.ts` checks every committed tape and fails the build on any identifier left behind. Name a tape after the model, firmware and scenario, never after the printer.

## Reduce printer reports

`reduce` folds one inbound JSON report into immutable printer state without
opening a connection. Pass Unix milliseconds as `now`.

```ts
import { initialState, reduce, Reading } from "@printhive/bambu"

const previous = initialState("000FAKE00000001")
const { state, delta, unclaimed } = reduce(previous, {
  print: { command: "push_status", mc_percent: 25, wifi_signal: "-55dBm" }
}, 1000)

const progress = Reading.match(state.progress.percent, {
  Present: ({ value, observedAt }) => `${value}% observed at ${observedAt}`,
  Absent: () => "No progress",
  Unknown: () => "Not reported",
  Unsupported: ({ source }) => `Unsupported per ${source.ref}`,
  Invalid: ({ issue }) => `Invalid report: ${issue}`
})
```

Every scalar is a `Reading`. Missing fields remain Unknown; a malformed leaf
becomes Invalid without discarding valid siblings. A non-object category body
invalidates its claimed readings with the raw body and report time. Categories
with no field-table claims appear in `unclaimed`. Non-object reports and
non-finite `now` values are caller errors and throw. Unsupported readings cite
an affirmative hardware fact from `@printhive/bambu-models`. Missing model facts
remain unknown. AMS removal explicitly makes its units Absent. Missing tray
colors never acquire a default.

Print keys replace previous values shallowly. AMS keys merge one level deeper;
`ams_exist_bits: "0"` clears the previous AMS base. Version modules merge by
module name, replacing each matching entry in full and keeping omitted named
modules. Each module reply replaces the previous nameless set. Retained named
modules keep their observation times even when array indexes shift.
Arrays of AMS units and trays replace their previous arrays.
Fan values retain the reported numeric scale without a percentage conversion.
HMS faults use JSON tuple keys `[attr,code]`, so clearing a fault does not change
other faults' keys. If either identity field is missing or is not a string or
number, the entry falls back to `#index`. Other collections use their single
identity field as the key.

Only touched sections are projected again. Present, Absent, and Invalid readings
carry their own `observedAt`; unrelated reports cannot refresh it. AMS absence
uses the observation time of `ams_exist_bits: "0"`. Invalid readings also keep
the raw value and decoding issue. Unknown and Unsupported carry no time.
`delta` contains sections whose content changed, excluding timestamp-only changes. An identical report
can refresh observation times while returning an empty delta. Untouched
sections retain object identity. Staleness is a caller decision.

`unclaimed` lists paths with no field-table row. The reducer retains unknown
wire values internally for later projections. Wire schemas are private and
have no package export.

Model resolution tries `printer_type` before the serial prefix. Version 0.1.1
of `@printhive/bambu-models` has no `printerTypes` entries, so reported model
codes also use its `modelByCode` lookup. That version lacks the A1 mini `030`
serial prefix. Such a printer remains unresolved until a known reported code
arrives. This package does not maintain a second identity table.

`hardware.capabilities` holds the raw `print.fun` mask, a hexadecimal string.

## Job lifecycle

`Lifecycle.observe(previous, state, now)` steps the job lifecycle with a reduced
report, and only when that report carried `gcode_state`. `Lifecycle.goOffline`
marks lost observation, which is never evidence of a stop. Every event carries
the task id reported with it:

- `JobStarted`: an observed change from not printing to printing.
- `JobAdopted`: the first observation after being offline found a job printing.
  It is not a start.
- `JobRecovered`: the first observation after being offline found a job paused.
- `JobPaused` and `JobResumed`.
- `JobEnded`: an observed change from printing to `FINISH`, `FAILED` or `IDLE`,
  including one that happened while offline. A `FINISH` revised to `FAILED` for
  the same task is ignored.

## Commands

`@printhive/bambu/protocol` holds the command algebra. One table, `protocol`,
defines every command: its access level, how its reply is matched, its encoder
and its reply type. `Command`, `ReplyOf` and `ReadOnlyCommand` come from it.

```ts
import { Command, dialects, encode, sequenceId } from "@printhive/bambu/protocol"

const encoded = encode(Command.Pause(), { dialect: dialects.P1S, sequenceId: sequenceId(2), capabilities: undefined })
```

- `Stop` has no fields, so a LAN stop never carries `job_id`. An acknowledged
  stop proves receipt only; a `JobEnded` event proves the stop.
- `ProjectFile` always sends `sequence_id` `"50000"` and its `task_id` as a
  string. Its reply is matched by task id. A caller can set neither.
- `PushAll` is answered by the next full report, which the P1S marks with
  `msg: 0`. `GetVersion` matches the dialect's reply sequence: an X1C answers
  with `"2021"`.
- `ChangeFilament` and `ProjectFile` take `FilamentTarget`s: `AmsSlot`, sent as
  `ams*4+slot`, or `ExternalSpool` 254 or 255, checked against the model.
- `SetBedTemperature` sends `set_bed_temp` when bit 39 of `fun` is set, and
  `M140` otherwise.

Each model has a `Dialect`: its handshake delay, `pushall` cadence, reply
rules, external spools, mapping format, and whether it accepts each command.
Every value is a `Fact` with its source. Only a fact read from a committed tape
is `Verified`; everything else is `Unverified` in the type, and `Fact.label`
says so. A model the registry adds fails to compile until it has a dialect, and
a command the protocol adds fails to compile until every dialect declares it.

Outcomes follow ADR-0056. `Acknowledged` and `Rejected` carry the reply.
`Ambiguous` means the bytes were written and nothing settled them. `NotSent` and
`SessionClosed` mean no byte was written, so a retry is safe.

`CommandSigner` signs requests before they are written. Its default signs
nothing: v1 targets Developer Mode.

`@printhive/bambu/provisional` lists the features rule 10 gates: Vortek,
timelapse storage and X.509-signed commands. They are not commands, and their
type cannot be `Verified`.

## License

MIT
