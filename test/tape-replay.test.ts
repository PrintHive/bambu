// Replays captured tapes through the reducer with no emulator involved. Tapes are the truth: each
// expectation below is read from the capture, not from what the reducer happens to produce.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Predicate } from "effect"
import { initialState, reduce, Reading, type PrinterState } from "../src/index.ts"
import { parseTape, type Tape } from "../src/tape/format.ts"

const test: (name: string, run: () => void) => void = process.versions.bun ? (await import("node:test")).test : (await import("vitest")).test

const load = (name: string): Tape => parseTape(readFileSync(new URL(`./fixtures/tapes/${name}`, import.meta.url), "utf8"))

/** The serial in a report topic, `device/<serial>/report`. */
const topicSerial = (topic: string): string => /^device\/([^/]+)\/(report|request)$/.exec(topic)?.[1] ?? assert.fail(`not a device topic: ${topic}`)

/** Every report the printer sent, in order, through the reducer. Times are milliseconds from the capture start. */
const replay = (tape: Tape): PrinterState => {
  const reports = tape.frames.flatMap((frame) => (frame.dir === "rx" && "frame" in frame && frame.topic.endsWith("/report") ? [frame] : []))
  const first = reports[0] ?? assert.fail("the tape has no reports")
  let state = initialState(topicSerial(first.topic))

  for (const report of reports) {
    state = reduce(state, report.frame, Math.round(report.t * 1000)).state
  }

  return state
}

const present = <A>(reading: Reading.Reading<A>): A =>
  Predicate.isTagged(reading, "Present") ? reading.value : assert.fail(`Expected Present, got ${reading._tag}`)

/** A projected section: each field is a Reading, and a collection's Reading holds more sections by key. */
type FieldValue = string | number | boolean | ReadonlyMap<string, Projection>

interface Projection {
  readonly [field: string]: Reading.Reading<FieldValue>
}

/** Paths of every Invalid reading: a field the tape carries that failed to decode. */
const invalidPaths = (projection: Projection, path: string): ReadonlyArray<string> =>
  Object.entries(projection).flatMap(([field, reading]) => {
    const at = `${path}.${field}`

    if (Predicate.isTagged(reading, "Invalid")) return [at]

    if (Predicate.isTagged(reading, "Present") && reading.value instanceof Map) {
      return [...reading.value].flatMap(([key, item]) => invalidPaths(item, `${at}[${key}]`))
    }

    return []
  })

const sections = (state: PrinterState): ReadonlyArray<readonly [string, Projection]> => [
  ["execution", state.execution],
  ["progress", state.progress],
  ["temperature", state.temperature],
  ["fans", state.fans],
  ["network", state.network],
  ["job", state.job],
  ["faults", state.faults],
  ["ams", state.ams],
  ["externalSpool", state.externalSpool],
  ["lighting", state.lighting],
  ["hardware", state.hardware]
]

test("the P1S idle tape replays to the state the printer reported", () => {
  const tape = load("p1s-01.09.00.00/idle-2026-09-18.jsonl")
  const state = replay(tape)

  assert.equal(tape.header.model, "P1S")
  assert.equal(state.model?.id, "P1S")
  assert.equal(present(state.execution.gcodeState), "FINISH")
  assert.equal(present(state.execution.nozzleType), "stainless_steel")
  // The last report lowered the bed reading back to 25.96875 after a 26.
  assert.equal(present(state.temperature.bed), 25.96875)
  assert.equal(present(state.temperature.nozzle), 29.5)
  // The signal moved between -28 and -30 dBm across the capture; the last report said -28.
  assert.equal(present(state.network.wifiSignal), "-28dBm")
  assert.equal(present(state.job.name), "scrubbed-job")

  const modules = present(state.hardware.modules)

  assert.deepEqual([...modules.keys()].sort(), ["ams/0", "esp32", "mc", "ota", "th"])
  assert.equal(present(modules.get("ota")?.softwareVersion ?? Reading.Unknown()), "01.09.00.00")
  assert.equal(present(modules.get("ota")?.productName ?? Reading.Unknown()), "Bambu Lab P1S")

  const units = present(state.ams.units)

  assert.equal(units.size, 1)
  assert.equal(present([...units.values()][0]?.trays ?? Reading.Unknown()).size, 4)
  assert.equal(present(present(state.lighting.lights).get("chamber_light")?.mode ?? Reading.Unknown()), "on")
})

test("no field the P1S idle tape carries fails to decode", () => {
  const state = replay(load("p1s-01.09.00.00/idle-2026-09-18.jsonl"))

  assert.deepEqual(sections(state).flatMap(([name, projection]) => invalidPaths(projection, name)), [])
})
