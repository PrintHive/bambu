// The emulator is tested with a plain MQTT client, never with this package's session: it must stand on the tapes
// and the registry alone.
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"
import { Duration, Effect, Fiber, Predicate, Schema, Stream } from "effect"
import { connect } from "@printhive/mqtt"
import type { Message, MqttClient } from "@printhive/mqtt"
import { describe, Fault, make, profiles, score } from "../src/emulator/index.ts"
import type { EmulatorOptions, VirtualPrinter } from "../src/emulator/index.ts"
import { p1sModules, p1sReport } from "../src/emulator/seed-p1s.ts"
import { parseTape } from "../src/tape/format.ts"
import { test } from "./support/harness.ts"
import { advance, clientTls, scenario, settle, stillPending, tls, within } from "./support/scenario.ts"

const tape = parseTape(readFileSync(new URL("./fixtures/tapes/p1s-01.09.00.00/idle-2026-09-18.jsonl", import.meta.url), "utf8"))
const serial = "01PMOCK00000001"
const accessCode = "FAKE0000"

const printer = (options: Partial<EmulatorOptions> = {}) => make({ model: "P1S", serial, accessCode, tls, ...options })

/** Connects a plain MQTT client and waits until the emulator has registered its session. */
const client = (emulator: VirtualPrinter, password = accessCode, keepAlive: Duration.Input = "60 seconds") => Effect.gen(function* () {
  const before = yield* emulator.sessionCount

  const mqtt = yield* connect({
    host: emulator.address.host,
    port: emulator.address.port,
    tls: clientTls,
    username: "bblp",
    password,
    reconnect: false,
    keepAlive
  })

  yield* within(emulator.awaitSessions(before + 1))

  return mqtt
})

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))

const json = (message: Message): Schema.JsonObject => decode(Buffer.from(message.payload).toString("utf8"))

const request = (mqtt: MqttClient, body: Schema.JsonObject) => mqtt.publish(`device/${serial}/request`, JSON.stringify(body))

/** Collects every report the client receives from now on. */
const collect = (mqtt: MqttClient) => Effect.gen(function* () {
  const reports = yield* mqtt.subscribe(`device/${serial}/report`)
  const received: Message[] = []

  yield* Effect.forkScoped(Stream.runForEach(reports, (message) => Effect.sync(() => received.push(message))))

  return received
})

const firstReport = (received: ReadonlyArray<Message>, predicate: (report: Schema.JsonObject) => boolean) =>
  within(Effect.gen(function* () {
    while (true) {
      const found = received.map(json).find(predicate)

      if (found !== undefined) return found

      yield* settle
    }
  }))

const closed = (mqtt: MqttClient) => within(Effect.gen(function* () {
  while (!Predicate.isTagged(yield* mqtt.status, "Closed")) yield* settle
}))

const printBody = (report: Schema.JsonObject): Schema.JsonObject => (Schema.is(Schema.JsonObject)(report.print) ? report.print : {})

test("the P1S seed is the tape's full report and module list", () => {
  const full = tape.frames.find((frame) => "frame" in frame && Schema.is(Schema.JsonObject)(frame.frame.print) && frame.frame.print.msg === 0)
  const version = tape.frames.find((frame) => frame.dir === "rx" && "frame" in frame && frame.frame.info !== undefined)

  assert.ok(full !== undefined && "frame" in full && version !== undefined && "frame" in version)

  const { command: _command, sequence_id: _sequence, msg: _msg, ...report } = printBody(full.frame)

  assert.deepEqual(p1sReport, report)
  assert.deepEqual({ module: p1sModules }, { module: Schema.is(Schema.JsonObject)(version.frame.info) ? version.frame.info.module : undefined })
})

test("the P1S emulator scores against the P1S tape on all five fidelity dimensions", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const mqtt = yield* client(emulator)

  yield* collect(mqtt)

  // Replay the tape's requests at the tape's times, starting the clock at its first request.
  let now = tape.frames.find((frame) => frame.dir === "tx")?.t ?? 0

  for (const frame of tape.frames) {
    if (frame.dir !== "tx" || !("frame" in frame)) continue

    yield* advance(`${Math.round((frame.t - now) * 1000)} millis`, "250 millis")
    now = frame.t
    yield* request(mqtt, frame.frame)
    yield* settle
  }

  yield* advance("10 seconds", "250 millis")

  const fidelity = score(tape, (yield* emulator.trace).map((entry) => entry.frame))

  assert.equal(fidelity.ackEnvelopes.score, 1, fidelity.ackEnvelopes.detail)
  assert.equal(fidelity.ackEnvelopes.samples, 3)
  assert.equal(fidelity.sequences.score, 1, fidelity.sequences.detail)
  assert.equal(fidelity.rejects.samples, 0)
  assert.ok(fidelity.cadence.score > 0.99, fidelity.cadence.detail)
  // Partial reports on the tape also carried a bed reading that the idle emulator does not vary.
  assert.ok(fidelity.keySet.score > 0.9, fidelity.keySet.detail)
  assert.match(fidelity.keySet.detail, /print\.push_status\/full 1\.00/)
})))

test("emulator output marks every behavior without a tape as UNVERIFIED", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()

  assert.ok(emulator.describe.some((line) => line.startsWith("pause reply VERIFIED (tape:")))
  assert.ok(emulator.describe.some((line) => line.startsWith("stop reply UNVERIFIED (inferred:")))

  const mqtt = yield* client(emulator)
  const received = yield* collect(mqtt)

  yield* request(mqtt, { print: { sequence_id: "1", command: "pause" } })
  yield* request(mqtt, { print: { sequence_id: "2", command: "stop", param: "" } })
  yield* firstReport(received, (report) => printBody(report).command === "stop")

  const trace = yield* emulator.trace
  const replyTo = (command: string) => trace.find((entry) => entry.frame.dir === "rx" && "frame" in entry.frame && printBody(entry.frame.frame).command === command)

  assert.equal(replyTo("pause")?.verified, true)
  assert.equal(replyTo("stop")?.verified, false)
  assert.ok(replyTo("stop")?.labels.every((label) => label.startsWith("UNVERIFIED")))
})))

test("every model outside the P1S tape is UNVERIFIED throughout", () => {
  for (const profile of Object.values(profiles)) {
    const lines = describe(profile)

    if (profile.model === "P1S") assert.ok(lines.some((line) => line.includes(" VERIFIED (tape:")))
    else assert.deepEqual(lines.filter((line) => !line.includes(" UNVERIFIED (")), [])
  }
})

test("fault: wrong credentials and a refused connection fail the CONNECT", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const wrong = yield* Effect.flip(client(emulator, "WRONG000"))

  assert.ok(Predicate.isTagged(wrong, "ConnectionRefused"))
  assert.equal(wrong.returnCode, 5)

  yield* emulator.inject(Fault.RefuseAuth({ code: 3 }))

  const refused = yield* Effect.flip(client(emulator))

  assert.ok(Predicate.isTagged(refused, "ConnectionRefused"))
  assert.equal(refused.returnCode, 3)
})))

test("fault: a stalled SUBACK holds the subscription", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()

  yield* emulator.inject(Fault.StallSuback())

  const mqtt = yield* client(emulator)
  const subscribing = yield* Effect.forkScoped(mqtt.subscribe(`device/${serial}/report`))

  yield* advance("30 seconds")
  assert.equal(yield* stillPending(subscribing), true)
  yield* Fiber.interrupt(subscribing)
})))

test("fault: silence ends the client's connection at the keep-alive deadline", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const mqtt = yield* client(emulator)

  yield* emulator.inject(Fault.Silence())
  // PINGREQ goes out 45 s into a 60 s keep-alive, and the PINGRESP deadline is one period later.
  yield* advance("100 seconds")
  assert.ok(Predicate.isTagged(yield* mqtt.status, "Connected"))
  yield* advance("10 seconds")

  const status = yield* mqtt.status

  assert.ok(Predicate.isTagged(status, "Closed"))
  assert.match(status.error.message, /PINGRESP/)
})))

test("fault: disconnects end the client's connection", () => scenario(Effect.gen(function* () {
  for (const mode of ["destroy", "end", "half-close"] as const) {
    const emulator = yield* printer()
    const mqtt = yield* client(emulator)

    yield* emulator.inject(Fault.Disconnect({ mode }))
    yield* closed(mqtt)
  }
})))

test("fault: a malformed report reaches the client as bytes that are not JSON", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const mqtt = yield* client(emulator)
  const received = yield* collect(mqtt)

  yield* emulator.inject(Fault.Malformed())
  yield* within(Effect.gen(function* () {
    while (!received.some((message) => Buffer.from(message.payload).toString("utf8") === "{\"print\":")) yield* settle
  }))
})))

test("fault: a half-open printer, silent with its socket kept and never dropping clients, fails the keep-alive", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer({ keepAlive: "ignore" })
  const mqtt = yield* client(emulator, accessCode, "10 seconds")

  yield* emulator.inject(Fault.Silence())
  yield* advance("15 seconds")
  assert.ok(Predicate.isTagged(yield* mqtt.status, "Connected"))
  yield* advance("10 seconds")
  assert.ok(Predicate.isTagged(yield* mqtt.status, "Closed"))
})))

test("faults: an ignored stop is acknowledged and changes nothing; dropped replies change state silently", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer({ report: { gcode_state: "RUNNING", task_id: "7" } })
  const mqtt = yield* client(emulator)
  const received = yield* collect(mqtt)

  yield* emulator.inject(Fault.IgnoreStop())
  yield* request(mqtt, { print: { sequence_id: "1", command: "stop", param: "" } })

  const ack = yield* firstReport(received, (report) => printBody(report).command === "stop")

  assert.equal(printBody(ack).result, "success")
  assert.equal((yield* emulator.world).gcode_state, "RUNNING")

  yield* emulator.clear
  yield* emulator.inject(Fault.DropReplies())
  yield* request(mqtt, { print: { sequence_id: "2", command: "pause", param: "" } })
  yield* within(Effect.gen(function* () {
    while ((yield* emulator.world).gcode_state !== "PAUSE") yield* settle
  }))

  assert.equal(received.map(json).some((report) => printBody(report).command === "pause"), false)
})))

test("fault: RejectNext rejects one request", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const mqtt = yield* client(emulator)
  const received = yield* collect(mqtt)

  yield* emulator.inject(Fault.RejectNext({ command: "pause", reason: "busy" }))
  yield* request(mqtt, { print: { sequence_id: "1", command: "pause", param: "" } })
  yield* request(mqtt, { print: { sequence_id: "2", command: "pause", param: "" } })

  const first = yield* firstReport(received, (report) => printBody(report).sequence_id === "1")
  const second = yield* firstReport(received, (report) => printBody(report).sequence_id === "2")

  assert.deepEqual([printBody(first).result, printBody(first).reason], ["failed", "busy"])
  assert.equal(printBody(second).result, "success")
})))

test("a started print prepares, then runs, on the emulator's clock", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const mqtt = yield* client(emulator)
  const received = yield* collect(mqtt)

  yield* request(mqtt, { print: { sequence_id: "50000", command: "project_file", task_id: "42", subtask_name: "part", param: "Metadata/plate_1.gcode" } })

  const ack = yield* firstReport(received, (report) => printBody(report).command === "project_file")

  assert.equal(printBody(ack).task_id, "42")
  assert.equal(printBody(ack).result, "success")
  yield* firstReport(received, (report) => printBody(report).gcode_state === "PREPARE")
  yield* advance("1 second")
  assert.equal((yield* emulator.world).gcode_state, "PREPARE")
  yield* advance("1 second")
  yield* firstReport(received, (report) => printBody(report).gcode_state === "RUNNING")
  assert.equal((yield* emulator.world).task_id, "42")
})))

test("an X1C answers get_version with sequence_id 2021 and pushes full reports on its own", () => scenario(Effect.gen(function* () {
  const emulator = yield* make({ model: "X1C", serial: "00MFAKE00000001", accessCode, tls })
  const mqtt = yield* connect({ host: emulator.address.host, port: emulator.address.port, tls: clientTls, username: "bblp", password: accessCode, reconnect: false })
  const reports = yield* mqtt.subscribe("device/00MFAKE00000001/report")
  const received: Message[] = []

  yield* Effect.forkScoped(Stream.runForEach(reports, (message) => Effect.sync(() => received.push(message))))
  yield* mqtt.publish("device/00MFAKE00000001/request", JSON.stringify({ info: { sequence_id: "0", command: "get_version" } }))

  const version = yield* firstReport(received, (report) => report.info !== undefined)

  assert.equal(Schema.is(Schema.JsonObject)(version.info) ? version.info.sequence_id : undefined, "2021")
  yield* advance("2 seconds")
  yield* firstReport(received, (report) => printBody(report).msg === 0)
})))
