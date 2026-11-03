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

## License

MIT

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
becomes Invalid without discarding valid siblings. Unsupported readings cite
an affirmative hardware fact from `@printhive/bambu-models`. Missing model facts
remain unknown. AMS removal explicitly makes its units Absent. Missing tray
colors never acquire a default.

Print keys replace previous values shallowly. AMS keys merge one level deeper;
`ams_exist_bits: "0"` clears the previous AMS base. Version modules merge by
module name. Arrays of AMS units and trays replace their previous arrays.
Fan values retain the reported numeric scale without a percentage conversion.

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
