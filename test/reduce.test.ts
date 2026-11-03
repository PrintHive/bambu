import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Predicate, Schema } from "effect"
import { initialState, reduce, Reading } from "../src/index.ts"
import { merge } from "../src/wire/merge.ts"
import { fieldRows } from "../src/state/fields.ts"
import { AccessCode, SequenceId, Serial } from "../src/wire/ids.ts"
import { Category, decodeReport } from "../src/wire/report.ts"

const test: (name: string, run: () => void) => void = process.versions.bun ? (await import("node:test")).test : (await import("vitest")).test
const serial = "000FAKE00000001"
const start = () => initialState(serial)

const present = <A>(reading: Reading.Reading<A>): Extract<Reading.Reading<A>, { _tag: "Present" }> => Reading.match(reading, {
  Present: (value) => value,
  Absent: () => assert.fail("Expected Present, got Absent"),
  Unknown: () => assert.fail("Expected Present, got Unknown"),
  Unsupported: () => assert.fail("Expected Present, got Unsupported"),
  Invalid: ({ issue }) => assert.fail(issue)
})

test("inbound schemas preserve missing fields and unknown category keys without defaults", () => {
  assert.deepEqual(Schema.decodeUnknownSync(Category)({ future: { value: 1 } }), { future: { value: 1 } })
  assert.deepEqual(decodeReport({ print: { wifi_signal: "-55dBm", future: true }, future: { result: 1 } }), { print: { wifi_signal: "-55dBm", future: true }, future: { result: 1 } })
  assert.deepEqual(decodeReport({}), {})
})

test("identifiers are validated and access codes are Redacted", () => {
  assert.equal(Schema.decodeUnknownSync(Serial)(serial), serial)
  assert.equal(Schema.decodeUnknownSync(SequenceId)("50000"), "50000")
  assert.throws(() => Schema.decodeUnknownSync(Serial)("invalid"))
  assert.throws(() => Schema.decodeUnknownSync(SequenceId)("invalid"))
  const code = Schema.decodeUnknownSync(AccessCode)("FAKE0000")
  assert.equal(JSON.stringify(code).includes("FAKE0000"), false)
  assert.equal(String(code).includes("FAKE0000"), false)
})

test("merge rules: print is shallow and a nested external spool is replaced", () => {
  const first = reduce(start(), { print: { gcode_state: "RUNNING", vt_tray: { id: "255", tray_type: "PLA", tray_color: "FFFFFFFF" } } }, 1).state
  const next = reduce(first, { print: { vt_tray: { k: 0.02 } } }, 2).state
  assert.equal(present(next.execution.gcodeState).value, "RUNNING")
  assert.deepEqual(next.externalSpool.color, Reading.Unknown())
  assert.equal(present(next.externalSpool.k).value, 0.02)
  assert.equal(present(first.externalSpool.color).value, "FFFFFFFF")
})

test("merge rules: AMS merges one level deeper but unit arrays replace", () => {
  const first = reduce(start(), { print: { ams: { ams_exist_bits: "1", tray_exist_bits: "15", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }] }] } } }, 1).state
  const next = reduce(first, { print: { ams: { tray_now: "0" } } }, 2).state
  assert.equal(present(next.ams.trayExistBits).value, "15")
  assert.equal(present(next.ams.units).observedAt, 1)
  const replaced = reduce(next, { print: { ams: { ams: [{ id: "1" }] } } }, 3).state
  assert.deepEqual([...present(replaced.ams.units).value.keys()], ["1"])
  assert.equal(present(replaced.ams.trayExistBits).value, "15")
})

test("merge rules: ams_exist_bits reset removes stale units and tray evidence", () => {
  const first = reduce(start(), { print: { ams: { ams_exist_bits: "1", tray_exist_bits: "15", ams: [{ id: "0" }] } } }, 1).state
  const result = reduce(first, { print: { ams: { ams_exist_bits: "0" } } }, 2)
  assert.deepEqual(result.state.ams.units, Reading.Absent({ observedAt: 2 }))
  assert.deepEqual(result.state.ams.trayExistBits, Reading.Unknown())
  assert.equal(present(result.state.ams.existBits).observedAt, 2)
  const unrelated = reduce(result.state, { print: { wifi_signal: "-55dBm", ams: { tray_now: "255" } } }, 3).state
  assert.deepEqual(unrelated.ams.units, Reading.Absent({ observedAt: 2 }))
  const reattached = reduce(result.state, { print: { ams: { ams_exist_bits: "1" } } }, 3).state
  assert.deepEqual(reattached.ams.units, Reading.Unknown())
})

test("per-path observedAt: wifi cannot refresh temperature or material evidence", () => {
  const first = reduce(start(), { print: { nozzle_temper: 210, vt_tray: { tray_type: "PLA" }, ams: { tray_now: "0", ams: [{ id: "0" }] } } }, 100).state
  const next = reduce(first, { print: { wifi_signal: "-55dBm" } }, 200).state
  assert.equal(present(next.temperature.nozzle).observedAt, 100)
  assert.equal(present(next.externalSpool.type).observedAt, 100)
  assert.equal(present(next.ams.units).observedAt, 100)
  assert.equal(present(next.network.wifiSignal).observedAt, 200)
  const ams = reduce(next, { print: { ams: { tray_now: "1" } } }, 300).state
  assert.equal(present(ams.ams.trayNow).observedAt, 300)
  assert.equal(present(ams.ams.units).observedAt, 100)
})

test("untouched sections retain object identity", () => {
  const first = reduce(start(), { print: { mc_percent: 10 } }, 1).state
  const result = reduce(first, { print: { wifi_signal: "-55dBm" } }, 2)
  assert.equal(result.state.progress, first.progress)
  assert.equal(result.state.ams, first.ams)
  assert.equal(result.state.hardware, first.hardware)
  assert.notEqual(result.state.network, first.network)
  assert.deepEqual(Object.keys(result.delta), ["network"])
  assert.equal(reduce(result.state, {}, 3).state.progress, first.progress)
})

test("idempotency: the same report twice produces an empty content delta", () => {
  const report = { print: { mc_percent: 10, ams: { ams: [{ id: "0", tray: [{ id: "0", k: 0.02 }] }] } } }
  const first = reduce(start(), report, 1).state
  const result = reduce(first, report, 2)
  assert.deepEqual(result.delta, {})
  assert.equal(present(result.state.progress.percent).observedAt, 2)
  assert.equal(present(result.state.ams.units).observedAt, 2)
  assert.equal(present(first.progress.percent).observedAt, 1)
})

test("Invalid fields carry their observation time through unrelated reports", () => {
  const first = reduce(start(), { print: { mc_percent: "bad" } }, 100).state
  assert.equal(first.progress.percent._tag, "Invalid")
  assert.ok("observedAt" in first.progress.percent)
  assert.equal(first.progress.percent.observedAt, 100)
  const next = reduce(first, { print: { layer_num: 3 } }, 200).state
  assert.deepEqual(next.progress.percent, first.progress.percent)
})

test("repeated Invalid fields refresh observation time without a content delta", () => {
  const report = { print: { mc_percent: "bad" } }
  const first = reduce(start(), report, 100).state
  const result = reduce(first, report, 200)
  assert.equal(result.state.progress.percent._tag, "Invalid")
  assert.ok("observedAt" in result.state.progress.percent)
  assert.equal(result.state.progress.percent.observedAt, 200)
  assert.deepEqual(result.delta, {})
  assert.notEqual(result.state.progress, first.progress)
  assert.equal(reduce(result.state, report, 200).state.progress, result.state.progress)
})

test("repeated AMS absence refreshes observation time without a content delta", () => {
  const report = { print: { ams: { ams_exist_bits: "0" } } }
  const first = reduce(start(), report, 100).state
  const result = reduce(first, report, 200)
  assert.deepEqual(result.state.ams.units, Reading.Absent({ observedAt: 200 }))
  assert.deepEqual(first.ams.units, Reading.Absent({ observedAt: 100 }))
  assert.deepEqual(result.delta, {})
  assert.notEqual(result.state.ams, first.ams)
  assert.equal(reduce(result.state, report, 200).state.ams, result.state.ams)
})

test("Invalid collections retain path observation time and refresh without a content delta", () => {
  const report = { print: { hms: "bad" } }
  const first = reduce(start(), report, 100).state
  assert.deepEqual(first.faults.hms, Reading.Invalid({ raw: "bad", issue: "Expected an array", observedAt: 100 }))
  const unrelated = reduce(first, { print: { print_error: 0 } }, 200).state
  assert.deepEqual(unrelated.faults.hms, first.faults.hms)
  const result = reduce(unrelated, report, 300)
  assert.deepEqual(result.state.faults.hms, Reading.Invalid({ raw: "bad", issue: "Expected an array", observedAt: 300 }))
  assert.deepEqual(result.delta, {})
})

test("Invalid leaf isolation preserves valid siblings and the raw invalid value", () => {
  const result = reduce(start(), { print: { mc_percent: "bad", nozzle_temper: 220, ams: { ams: [{ id: "0", tray: [{ id: "0", k: "bad", tray_type: "PLA" }] }] } } }, 1)
  assert.equal(Reading.match(result.state.progress.percent, { Invalid: ({ raw }) => raw, Present: () => null, Absent: () => null, Unknown: () => null, Unsupported: () => null }), "bad")
  assert.equal(present(result.state.temperature.nozzle).value, 220)
  const unit = present(result.state.ams.units).value.get("0")
  assert.ok(unit)
  const tray = present(unit.trays).value.get("0")
  assert.ok(tray)
  assert.equal(present(tray.type).value, "PLA")
  assert.equal(tray.k._tag, "Invalid")
})

test("Unsupported gating uses a sourced bambu-models fact and unknown facts remain Unknown", () => {
  const a1 = reduce(initialState("039FAKE00000001"), { print: { chamber_temper: 0, ctt: 0 } }, 1).state
  assert.equal(a1.temperature.chamber._tag, "Unsupported")
  Reading.match(a1.temperature.chamber, {
    Unsupported: ({ source }) => {
      assert.equal(source.model, "A1")
      assert.equal(source.fact, "chamberSensor")
      assert.equal(source.source, "community-mit")
      assert.match(source.ref, /CHAMBER_TEMPERATURE/)
    },
    Present: () => assert.fail(), Absent: () => assert.fail(), Unknown: () => assert.fail(), Invalid: () => assert.fail()
  })
  assert.equal(start().temperature.chamber._tag, "Unknown")
})

test("model resolution prefers printer_type over serial prefix and reprojects support without refreshing evidence", () => {
  const first = reduce(initialState("039FAKE00000001"), { print: { chamber_temper: 25 } }, 10).state
  assert.equal(first.model?.id, "A1")
  const result = reduce(first, { print: { printer_type: "BL-P001" } }, 20)
  assert.equal(result.state.model?.id, "X1C")
  assert.equal(result.state.model?.via, "printer_type")
  assert.equal(present(result.state.temperature.chamber).observedAt, 10)
  assert.equal(initialState("01PFAKE00000001").model?.id, "P1S")
  assert.equal(reduce(first, { print: { printer_type: "future" } }, 30).state.model?.id, "A1")
})

test("registry gap: bambu-models 0.1.1 lacks the A1 mini 030 prefix", () => {
  assert.equal(initialState("030FAKE00000001").model, undefined)
  assert.equal(reduce(start(), { print: { printer_type: "N1" } }, 1).state.model?.id, "A1M")
})

test("modules are keyed by identity: identical get_version replies never duplicate", () => {
  const report = { info: { command: "get_version", sequence_id: "2021", module: [{ name: "ota", sn: serial, sw_ver: "01.00.00.00" }, { name: "ams/0", sw_ver: "01.00.00.00" }] } }
  const first = reduce(start(), report, 1).state
  const result = reduce(first, report, 2)
  assert.deepEqual([...present(result.state.hardware.modules).value.keys()], ["ota", "ams/0"])
  assert.deepEqual(result.delta, {})
  assert.equal(present(result.state.hardware.modules).observedAt, 2)
  const updated = reduce(result.state, { info: { module: [{ name: "ota", sw_ver: "02.00.00.00" }] } }, 3).state
  const modules = present(updated.hardware.modules).value
  assert.equal(modules.size, 2)
  assert.equal(present(modules.get("ota")!.softwareVersion).value, "02.00.00.00")
  assert.equal(present(modules.get("ams/0")!.softwareVersion).observedAt, 2)
})

test("unclaimed paths include unknown nested leaves and unknown categories", () => {
  const result = reduce(start(), { print: { command: "push_status", sequence_id: "1", mc_percent: 1, future: { nested: 9 }, ams: { ams: [{ id: "0", future: true }] } }, future: { flag: true } }, 1)
  assert.deepEqual(result.unclaimed, ["print.future.nested", "print.ams.ams.0.future", "future.flag"])
  assert.equal(fieldRows.length, new Set(fieldRows.map((row) => row.wirePath)).size)
})

for (const name of ["MOCK-A1", "MOCK-X1CMULTIAMS", "MOCK-H2D"]) {
  test(`pybambu fixture ${name} decodes with zero Invalid readings`, () => {
    const fixture = Schema.decodeUnknownSync(Schema.Struct({ pushall: Schema.JsonObject, get_version: Schema.JsonObject }))(JSON.parse(readFileSync(new URL(`./fixtures/pybambu/${name}.json`, import.meta.url), "utf8")))
    const first = reduce(start(), fixture.pushall, 1)
    const result = reduce(first.state, fixture.get_version, 2)
    const invalid: string[] = []
    JSON.stringify(result.state, (key, value: Schema.Json | Map<string, Schema.Json>) => {
      if (value instanceof Map) return [...value]

      if (Schema.is(Schema.JsonObject)(value) && Predicate.isTagged(value, "Invalid")) invalid.push(key)

      return value
    })
    assert.deepEqual(invalid, [])
    assert.ok(first.unclaimed.length > 0)
    assert.equal(present(result.state.hardware.modules).value.size, name === "MOCK-A1" ? 5 : 10)
  })
}

test("field table projects temperatures, fans, jobs, raw HMS codes, lights, and tray leaves", () => {
  const { state, unclaimed } = reduce(start(), { print: {
    gcode_state: "FUTURE_STATE", home_flag: 123, sdcard: true,
    nozzle_diameter: "0.4", nozzle_type: "stainless_steel",
    mc_percent: 25, mc_remaining_time: 12, layer_num: 3, total_layer_num: 100,
    nozzle_temper: 201, nozzle_target_temper: 220, bed_temper: 50, bed_target_temper: 60,
    chamber_temper: 30, ctt: 35, cooling_fan_speed: "7", big_fan1_speed: "8", big_fan2_speed: "9", heatbreak_fan_speed: "10",
    subtask_id: "1", task_id: "2", subtask_name: "Synthetic job", wifi_signal: "-55dBm",
    print_error: 0, hms: [{ code: 1234, attr: 56 }],
    lights_report: [{ node: "chamber_light", mode: "on" }],
    ams: { ams_exist_bits: "1", tray_exist_bits: "1", tray_now: "0", tray_tar: "255", ams: [{ id: "0", humidity: "5", temp: "27.5", tray_exist_bits: "1", tray: [{ id: "0", tray_type: "PLA", remain: 50, k: 0.02 }] }] },
    vt_tray: { id: "255", tray_type: "PETG", tray_color: "FFFFFFFF", remain: 70, k: 0.03 }
  } }, 123)

  assert.deepEqual(unclaimed, [])
  assert.deepEqual(Object.values(state.temperature).map((reading) => present(reading).value), [201, 220, 50, 60, 30, 35])
  assert.deepEqual(Object.values(state.fans).map((reading) => present(reading).value), [7, 8, 9, 10])
  assert.deepEqual(Object.values(state.progress).map((reading) => present(reading).value), [25, 12, 3, 100])
  assert.deepEqual(Object.values(state.job).map((reading) => present(reading).value), ["1", "2", "Synthetic job"])
  assert.equal(present(state.execution.gcodeState).value, "FUTURE_STATE")
  assert.equal(present(state.execution.homeFlag).value, 123)
  assert.equal(present(state.execution.sdcard).value, true)
  assert.equal(present(state.execution.nozzleDiameter).value, 0.4)
  assert.equal(present(state.execution.nozzleType).value, "stainless_steel")
  assert.equal(present(state.faults.printError).value, 0)
  const hms = present(state.faults.hms).value.get("#0")
  assert.ok(hms)
  assert.equal(present(hms.code).value, 1234)
  assert.equal(present(hms.attr).value, 56)
  const light = present(state.lighting.lights).value.get("chamber_light")
  assert.ok(light)
  assert.equal(present(light.mode).value, "on")
  const unit = present(state.ams.units).value.get("0")
  assert.ok(unit)
  assert.equal(present(unit.humidity).value, 5)
  assert.equal(present(unit.temperature).value, 27.5)
  assert.equal(present(unit.trayExistBits).value, "1")
  const tray = present(unit.trays).value.get("0")
  assert.ok(tray)
  assert.equal(present(tray.remaining).value, 50)
  assert.equal(present(tray.k).observedAt, 123)
  assert.deepEqual(tray.color, Reading.Unknown())
  assert.equal(present(state.externalSpool.type).value, "PETG")
  assert.equal(present(state.externalSpool.remaining).value, 70)
})

test("empty reports have no unclaimed paths and known collection shapes fail locally", () => {
  assert.deepEqual(reduce(start(), {}, 1).unclaimed, [])
  const result = reduce(start(), { print: { hms: "bad", mc_percent: 10 } }, 2)
  assert.equal(result.state.faults.hms._tag, "Invalid")
  assert.equal(present(result.state.progress.percent).value, 10)
  assert.deepEqual(reduce(start(), { future: { command: "new" } }, 3).unclaimed, ["future.command"])
})


test("malformed categories cannot discard valid sibling categories", () => {
  const result = reduce(start(), { print: { nozzle_temper: 220 }, system: 3 }, 100)
  assert.deepEqual(result.state.temperature.nozzle, Reading.Present({ value: 220, observedAt: 100 }))
  assert.deepEqual(result.unclaimed, ["system"])
})

test("null print invalidates claimed fields at the report time and recovers per path", () => {
  const first = reduce(start(), { print: { nozzle_temper: 210, ams: { ams: [{ id: "0" }] } } }, 50).state
  const result = reduce(first, { print: null }, 100)

  for (const section of ["execution", "progress", "temperature", "fans", "network", "job", "faults", "ams", "externalSpool", "lighting"] as const) {
    for (const reading of Object.values(result.state[section])) {
      assert.deepEqual(reading, Reading.Invalid({ raw: null, issue: "Expected an object at print", observedAt: 100 }))
    }
  }

  assert.deepEqual(result.unclaimed, [])
  assert.deepEqual(reduce(start(), { print: null }, 100).state.temperature.nozzle, result.state.temperature.nozzle)
  const repeated = reduce(result.state, { print: null }, 200)
  assert.deepEqual(repeated.delta, {})
  assert.deepEqual(repeated.state.temperature.nozzle, Reading.Invalid({ raw: null, issue: "Expected an object at print", observedAt: 200 }))
  const unrelated = reduce(repeated.state, { info: { module: [{ name: "ota" }] } }, 300).state
  assert.equal(unrelated.temperature, repeated.state.temperature)
  const recovered = reduce(unrelated, { print: { nozzle_temper: 230 } }, 400).state
  assert.deepEqual(recovered.temperature.nozzle, Reading.Present({ value: 230, observedAt: 400 }))
  assert.deepEqual(recovered.ams.units, Reading.Unknown())
  assert.deepEqual(first.temperature.nozzle, Reading.Present({ value: 210, observedAt: 50 }))
})

test("malformed category replacement forgets descendant observation times", () => {
  const first = merge({ raw: {}, observedAt: new Map() }, { print: { ams: { ams: [{ id: "0" }] } } }, 50)
  const next = merge(first, { print: null }, 100)
  assert.deepEqual(next.raw, { print: null })
  assert.deepEqual([...next.observedAt], [["print", 100]])
})

test("non-object reports and non-finite times remain caller errors", () => {
  for (const report of [null, 3, "bad", []]) {
    assert.throws(() => decodeReport(report))
    // @ts-expect-error Deliberately bypass the object-only API to verify caller validation.
    assert.throws(() => reduce(start(), report, 100))
  }

  for (const now of [NaN, Infinity, -Infinity]) assert.throws(() => reduce(start(), { print: null }, now))
})


test("all non-object category bodies invalidate claimed fields", () => {
  for (const body of [3, true, "bad", [], [{}]]) {
    const result = reduce(start(), { print: body, info: body }, 100)
    const invalid = Reading.Invalid({ raw: body, issue: "Expected an object at print", observedAt: 100 })
    assert.deepEqual(result.state.temperature.nozzle, invalid)
    assert.deepEqual(result.state.faults.hms, invalid)
    assert.deepEqual(result.state.hardware.modules, Reading.Invalid({ raw: body, issue: "Expected an object at info", observedAt: 100 }))
  }
})
