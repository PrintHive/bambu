// PrinterSession against the in-process emulator, over real loopback TLS, with time on TestClock.
import assert from "node:assert/strict"
import { Deferred, Effect, Fiber, Layer, Predicate, Redacted, Ref, Schema, Stream } from "effect"
import { open } from "../src/client/index.ts"
import type { PrinterSession, PublishHooks, StateChange } from "../src/client/index.ts"
import { Fault, make } from "../src/emulator/index.ts"
import type { EmulatorOptions, VirtualPrinter } from "../src/emulator/index.ts"
import { Lifecycle, Reading } from "../src/index.ts"
import type { LifecycleEvent, PrinterState } from "../src/index.ts"
import { AmsSlot, Command, CommandSigner, ExternalSpool, Refused, TaskId } from "../src/protocol/index.ts"
import type { Access, AmsMapping } from "../src/protocol/index.ts"
import { test } from "./support/harness.ts"
import { advance, clientTls, scenario, settle, stillPending, tls, within } from "./support/scenario.ts"

const serial = "01PMOCK00000001"
const accessCode = "FAKE0000"

const printer = (options: Partial<EmulatorOptions> = {}) => make({ model: "P1S", serial, accessCode, tls, ...options })

const connectTo = <X extends Access>(emulator: VirtualPrinter, access: X, previous?: { state: PrinterState; lifecycle: Lifecycle.Lifecycle }) =>
  open({
    host: emulator.address.host,
    port: emulator.address.port,
    serial: emulator.serial,
    accessCode: Redacted.make(accessCode),
    tls: clientTls,
    access,
    previous
  })

/** Opens a session and runs its handshake: subscribe, wait 2 s, get_version, pushall. */
const ready = <X extends Access>(emulator: VirtualPrinter, access: X, previous?: { state: PrinterState; lifecycle: Lifecycle.Lifecycle }) =>
  Effect.gen(function* () {
    const pushalls = (yield* emulator.requests).filter((request) => request.command === "pushall").length
    const session = yield* connectTo(emulator, access, previous)

    yield* within(emulator.awaitSubscribed)
    yield* settle
    yield* advance("2 seconds")
    yield* within(emulator.awaitRequest("pushall", pushalls + 1))
    yield* within(waitForStatus(session, "Ready"))

    return session
  })

const waitForStatus = (session: PrinterSession<Access>, tag: "Subscribing" | "Handshaking" | "Ready" | "EpochEnded") =>
  session.status.pipe(Stream.filter(Predicate.isTagged(tag)), Stream.runHead, Effect.asVoid)

/** Every StateChange from now on. */
const record = (session: PrinterSession<Access>) => Effect.gen(function* () {
  const seen: StateChange[] = []

  yield* Effect.forkScoped(Stream.runForEach(session.changes, (change) => Effect.sync(() => seen.push(change))))
  yield* settle

  return seen
})

const events = (seen: ReadonlyArray<StateChange>): ReadonlyArray<LifecycleEvent> => seen.flatMap((change) => change.events)

const until = (condition: Effect.Effect<boolean>) => within(Effect.gen(function* () {
  while (!(yield* condition)) yield* settle
}))

const gcode = (session: PrinterSession<Access>) => Effect.map(session.state.get, (state) =>
  Predicate.isTagged(state.execution.gcodeState, "Present") ? state.execution.gcodeState.value : undefined)

const startPrint = (taskId: string, amsMapping: AmsMapping = [AmsSlot.make({ ams: 0, slot: 2 })]) => Command.ProjectFile({
  taskId: Schema.decodeSync(TaskId)(taskId),
  subtaskName: "part",
  file: { url: "file:///sdcard/part.3mf", name: "part.3mf" },
  plate: 1,
  amsMapping,
  options: { timelapse: false, bedLevelling: false, flowCalibration: false, vibrationCalibration: false, layerInspect: false }
})

const hooks = (log: Ref.Ref<ReadonlyArray<string>>, name: string, before: Effect.Effect<void, Refused> = Effect.void): PublishHooks => ({
  beforePublish: Effect.andThen(before, Ref.update(log, (entries) => [...entries, `${name}:before`])),
  onPublished: Ref.update(log, (entries) => [...entries, `${name}:published`])
})

const count = (emulator: VirtualPrinter, command: string) => Effect.map(emulator.requests, (all) => all.filter((request) => request.command === command).length)

// Publication rules (proposal, "Publication rules, each a named phase 2 test").

test("publication rule 1: beforePublish and the first write are one step, with nothing between them", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")
  const log = yield* Ref.make<ReadonlyArray<string>>([])
  const gate = yield* Deferred.make<void>()

  // A's authority check is slow. B, sent meanwhile, must not run its check or write before A's write.
  const a = yield* Effect.forkScoped(session.send(Command.Pause(), hooks(log, "A", Deferred.await(gate))))

  yield* settle

  const b = yield* Effect.forkScoped(session.send(Command.Resume(), hooks(log, "B")))

  yield* emulator.update({ wifi_signal: "-40dBm" })
  yield* settle
  assert.deepEqual(yield* Ref.get(log), [])
  assert.equal(yield* count(emulator, "pause"), 0)
  yield* Deferred.succeed(gate, undefined)
  yield* Fiber.join(a)
  yield* Fiber.join(b)
  assert.deepEqual(yield* Ref.get(log), ["A:before", "A:published", "B:before", "B:published"])

  const order = (yield* emulator.requests).map((request) => request.command).filter((command) => command === "pause" || command === "resume")

  assert.deepEqual(order, ["pause", "resume"])
})))

test("publication rule 1: a handoff before beforePublish is refused and nothing is written; one after it fences an epoch that already wrote", () =>
  scenario(Effect.gen(function* () {
    const emulator = yield* printer()
    const session = yield* ready(emulator, "control")
    const generation = yield* Ref.make(1)

    // hive-link's check: the claim generation it closed over must still be current.
    const claim = (expected: number): PublishHooks => ({
      beforePublish: Effect.flatMap(Ref.get(generation), (current) => current === expected ? Effect.void : Effect.fail(new Refused({ reason: `generation ${current}` }))),
      onPublished: Effect.void
    })

    yield* Ref.set(generation, 2)

    const refused = yield* Effect.flip(session.send(startPrint("100"), claim(1)))

    assert.ok(Predicate.isTagged(refused, "NotSent"))
    assert.match(refused.reason, /refused: generation 2/)
    yield* settle
    assert.equal(yield* count(emulator, "project_file"), 0)

    const written = yield* session.send(startPrint("101"), {
      ...claim(2),
      onPublished: Ref.set(generation, 3)
    })

    assert.ok(Predicate.isTagged(written, "Acknowledged"))
    assert.equal(yield* Ref.get(generation), 3)
    assert.equal(yield* count(emulator, "project_file"), 1)
  })))

test("publication rule 2: an interrupted caller cannot stop the region; onPublished still runs once the bytes left", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")
  const log = yield* Ref.make<ReadonlyArray<string>>([])
  const gate = yield* Deferred.make<void>()
  const caller = yield* Effect.forkScoped(session.send(startPrint("200"), hooks(log, "S", Deferred.await(gate))))

  yield* settle
  yield* Fiber.interrupt(caller).pipe(Effect.forkScoped)
  yield* settle
  yield* Deferred.succeed(gate, undefined)
  yield* within(emulator.awaitRequest("project_file"))
  yield* until(Effect.map(Ref.get(log), (entries) => entries.length === 2))
  assert.deepEqual(yield* Ref.get(log), ["S:before", "S:published"])
  yield* settle
  assert.deepEqual(yield* Ref.get(log), ["S:before", "S:published"])
  assert.equal(yield* count(emulator, "project_file"), 1)
})))

test("publication rule 2: a failure inside onPublished after a write resolves as Ambiguous, never NotSent", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")
  const outcome = yield* session.send(startPrint("300"), { beforePublish: Effect.void, onPublished: Effect.die(new Error("journal write failed")) })

  assert.ok(Predicate.isTagged(outcome, "Ambiguous"))
  assert.equal(outcome.cause, "publish-hook-failed")
  yield* within(emulator.awaitRequest("project_file"))
})))

test("a caller interrupted before the session takes its command sends nothing", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* connectTo(emulator, "control")

  yield* within(emulator.awaitSubscribed)

  // The handshake has not run, so the command waits in the session's queue.
  const caller = yield* Effect.forkScoped(session.send(Command.Pause()))

  yield* settle
  yield* Fiber.interrupt(caller)
  yield* advance("2 seconds")
  yield* within(emulator.awaitRequest("pushall"))
  yield* settle
  assert.equal(yield* count(emulator, "pause"), 0)
})))

test("NotSent and SessionClosed mean no byte was written", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")

  // The P1S tape shows one external spool, so 255 is refused before encoding finishes.
  const unencodable = yield* Effect.flip(session.send(Command.ChangeFilament({ target: ExternalSpool.make({ id: 255 }), currentTemperature: 220, targetTemperature: 220 })))

  assert.ok(Predicate.isTagged(unencodable, "NotSent"))

  yield* session.close

  const closed = yield* Effect.flip(session.send(Command.Pause()))

  assert.ok(Predicate.isTagged(closed, "SessionClosed"))
  assert.equal(yield* count(emulator, "ams_change_filament"), 0)
  assert.equal(yield* count(emulator, "pause"), 0)
})))

test("a send after the session's scope has closed fails with SessionClosed instead of waiting", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* Effect.scoped(ready(emulator, "control"))
  const late = yield* within(Effect.flip(session.send(Command.Pause())))

  assert.ok(Predicate.isTagged(late, "SessionClosed"))
  assert.equal(yield* count(emulator, "pause"), 0)
})))

test("a close after a write resolves as Ambiguous(connection-lost), and the session never resends", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")

  yield* emulator.inject(Fault.DropReplies())

  const sending = yield* Effect.forkScoped(session.send(Command.Pause()))

  yield* within(emulator.awaitRequest("pause"))
  yield* emulator.inject(Fault.Disconnect({ mode: "destroy" }))

  const outcome = yield* within(Fiber.join(sending))

  assert.ok(Predicate.isTagged(outcome, "Ambiguous"))
  assert.equal(outcome.cause, "connection-lost")
  yield* within(waitForStatus(session, "EpochEnded"))

  // A new epoch is the caller's choice, and it carries nothing over.
  yield* emulator.clear
  yield* ready(emulator, "control")
  yield* advance("30 seconds")
  assert.equal(yield* count(emulator, "pause"), 1)
})))

test("a written command with no reply resolves as Ambiguous(timeout) at the dialect's deadline", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")

  yield* emulator.inject(Fault.DropReplies())

  const sending = yield* Effect.forkScoped(session.send(Command.Resume()))

  yield* within(emulator.awaitRequest("resume"))
  yield* advance("9 seconds")
  assert.equal(yield* stillPending(sending), true)
  yield* advance("1 second")

  const outcome = yield* within(Fiber.join(sending))

  assert.ok(Predicate.isTagged(outcome, "Ambiguous"))
  assert.equal(outcome.cause, "timeout")
})))

test("a rejected command resolves as Rejected with the printer's reason", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")

  yield* emulator.inject(Fault.RejectNext({ command: "pause", reason: "busy" }))

  const outcome = yield* session.send(Command.Pause())

  assert.ok(Predicate.isTagged(outcome, "Rejected"))
  assert.equal(outcome.reason, "busy")
})))

// The numbered rules (proposal, "Knowledge a rewrite must keep"). Rule 8 is tested in @hiv3d/camera.

test("rule 1: Start Print reaches the printer with sequence_id 50000 and a string task_id, and its evidence matches the task id", () =>
  scenario(Effect.gen(function* () {
    const emulator = yield* printer()
    const session = yield* ready(emulator, "control")
    const seen = yield* record(session)
    const outcome = yield* session.send(startPrint("4242"), { beforePublish: Effect.void, onPublished: Effect.void })
    const request = yield* emulator.awaitRequest("project_file")

    assert.ok(Predicate.isTagged(outcome, "Acknowledged"))
    assert.equal(request.body.sequence_id, "50000")
    assert.equal(request.body.task_id, "4242")
    yield* until(Effect.sync(() => events(seen).length > 0))
    assert.deepEqual(events(seen)[0], Lifecycle.JobStarted({ taskId: "4242", gcodeState: "PREPARE" }))
  })))

test("rule 2: an acknowledged stop is not a stop; only a gcode_state change is", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer({ report: { gcode_state: "RUNNING", task_id: "7" } })
  const session = yield* ready(emulator, "control")
  const seen = yield* record(session)

  yield* emulator.inject(Fault.IgnoreStop())

  const ignored = yield* session.send(Command.Stop())

  assert.ok(Predicate.isTagged(ignored, "Acknowledged"))
  assert.equal((yield* emulator.requests).find((request) => request.command === "stop")?.body.job_id, undefined)
  yield* settle
  assert.equal(yield* gcode(session), "RUNNING")
  assert.deepEqual(events(seen), [])

  yield* emulator.clear
  yield* session.send(Command.Stop())
  yield* until(Effect.sync(() => events(seen).length > 0))
  assert.deepEqual(events(seen), [Lifecycle.JobEnded({ taskId: "7", outcome: "FAILED" })])
})))

test("rule 2: losing the connection while printing is not a stop", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer({ report: { gcode_state: "RUNNING", task_id: "7" } })
  const session = yield* ready(emulator, "control")
  const seen = yield* record(session)

  yield* emulator.inject(Fault.Disconnect({ mode: "destroy" }))
  yield* within(waitForStatus(session, "EpochEnded"))
  assert.deepEqual(events(seen), [])
  assert.equal((yield* session.lifecycle).online, false)
})))

test("rule 3: partial reports merge shallowly through the session, AMS resets on ams_exist_bits 0, and deltas are sparse", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "control")
  const seen = yield* record(session)

  yield* emulator.update({ wifi_signal: "-41dBm" })
  yield* until(Effect.sync(() => seen.length > 0))

  const partial = seen[0]

  assert.ok(partial !== undefined)
  assert.deepEqual(Object.keys(partial.delta), ["network"])

  const state = yield* session.state.get

  // Untouched readings keep the full report's values.
  assert.equal(Reading.match(state.execution.gcodeState, { Present: ({ value }) => value, Absent: () => "", Unknown: () => "", Unsupported: () => "", Invalid: () => "" }), "FINISH")
  assert.ok(Predicate.isTagged(state.ams.units, "Present"))

  yield* emulator.update({ ams: { ams_exist_bits: "0" } })
  yield* until(Effect.map(session.state.get, (current) => Predicate.isTagged(current.ams.units, "Absent")))
})))

test("rule 4: across epochs, OFFLINE to RUNNING adopts, OFFLINE to PAUSE recovers, and FINISH revised to FAILED is ignored", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer({ report: { gcode_state: "RUNNING", task_id: "9" } })
  const first = yield* ready(emulator, "control")

  yield* until(Effect.map(first.lifecycle, (lifecycle) => lifecycle.online))

  const adopted = yield* first.lifecycle

  assert.equal(adopted.gcodeState, "RUNNING")
  yield* emulator.inject(Fault.Disconnect({ mode: "destroy" }))
  yield* within(waitForStatus(first, "EpochEnded"))
  yield* emulator.update({ gcode_state: "PAUSE" })

  const previous = { state: yield* first.state.get, lifecycle: yield* first.lifecycle }
  const second = yield* connectTo(emulator, "control", previous)
  const seen = yield* record(second)

  yield* within(emulator.awaitSubscribed)
  yield* settle
  yield* advance("2 seconds")
  yield* until(Effect.sync(() => events(seen).length > 0))
  assert.deepEqual(events(seen)[0], Lifecycle.JobRecovered({ taskId: "9" }))

  yield* emulator.update({ gcode_state: "RUNNING" })
  yield* emulator.update({ gcode_state: "FINISH" })
  yield* until(Effect.sync(() => events(seen).some(Predicate.isTagged("JobEnded"))))
  yield* emulator.update({ gcode_state: "FAILED" })
  yield* settle
  yield* until(Effect.map(gcode(second), (state) => state === "FAILED"))
  assert.deepEqual(events(seen).map((event) => event._tag), ["JobRecovered", "JobResumed", "JobEnded"])
  assert.equal((yield* second.lifecycle).gcodeState, "FINISH")

  // The first epoch's start was an adoption, not a start.
  const fresh = yield* printer({ report: { gcode_state: "RUNNING", task_id: "10" } })
  const third = yield* connectTo(fresh, "observe")
  const thirdSeen = yield* record(third)

  yield* within(fresh.awaitSubscribed)
  yield* settle
  yield* advance("2 seconds")
  yield* until(Effect.sync(() => events(thirdSeen).length > 0))
  assert.deepEqual(events(thirdSeen), [Lifecycle.JobAdopted({ taskId: "10", gcodeState: "RUNNING" })])
})))

test("rule 5: subscribe, wait 2 s, get_version, then pushall", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()

  yield* connectTo(emulator, "observe")
  yield* within(emulator.awaitSubscribed)
  yield* settle
  yield* advance("1999 millis", "1999 millis")
  assert.deepEqual(yield* emulator.requests, [])
  yield* advance("1 millis", "1 millis")
  yield* within(emulator.awaitRequest("pushall"))
  assert.deepEqual((yield* emulator.requests).map((request) => request.command), ["get_version", "pushall"])
  assert.deepEqual((yield* emulator.requests).map((request) => request.body.sequence_id), ["0", "1"])
})))

test("rule 5: a P1S repeats pushall every 5 minutes; an X1C pushes on its own", () => scenario(Effect.gen(function* () {
  const p1s = yield* printer()

  yield* ready(p1s, "observe")
  yield* advance("299 seconds", "5 seconds")
  assert.equal(yield* count(p1s, "pushall"), 1)
  yield* advance("1 second")
  yield* within(p1s.awaitRequest("pushall", 2))
  yield* advance("300 seconds", "5 seconds")
  yield* within(p1s.awaitRequest("pushall", 3))

  const x1c = yield* make({ model: "X1C", serial: "00MMOCK00000001", accessCode, tls })

  yield* ready(x1c, "observe")
  yield* advance("600 seconds", "5 seconds")
  assert.equal(yield* count(x1c, "pushall"), 1)
})))

test("rule 5: an X1C answers get_version with sequence_id 2021, and the session still matches it", () => scenario(Effect.gen(function* () {
  const x1c = yield* make({ model: "X1C", serial: "00MMOCK00000001", accessCode, tls })
  const session = yield* ready(x1c, "observe")
  const outcome = yield* session.send(Command.GetVersion())

  assert.ok(Predicate.isTagged(outcome, "Acknowledged"))
  assert.equal(outcome.reply.sequenceId, "2021")
})))

test("rule 6: the model resolves from printer_type first, then from the serial prefix", () => scenario(Effect.gen(function* () {
  const emulator = yield* make({ model: "X1C", serial: "00MMOCK00000001", accessCode, tls })
  const session = yield* ready(emulator, "observe")

  assert.equal((yield* session.state.get).model?.via, "serial_prefix")
  assert.equal((yield* session.state.get).model?.id, "X1C")

  // A reported code wins over the prefix: C12 is the P1S code in @printhive/bambu-models.
  yield* emulator.update({ printer_type: "C12" })
  yield* until(Effect.map(session.state.get, (state) => state.model?.via === "printer_type"))
  assert.equal((yield* session.state.get).model?.id, "P1S")

  // Open question 3: @printhive/bambu-models 0.1.1 lacks the A1 mini's 030 prefix, so it stays unresolved.
  const a1mini = yield* make({ model: "A1M", serial: "030MOCK00000001", accessCode, tls })
  const unresolved = yield* ready(a1mini, "observe")

  assert.equal((yield* unresolved.state.get).model, undefined)
})))

test("rule 9: a load target is sent as ams*4+slot, an external spool the model lacks is refused, and fun bit 39 picks set_bed_temp", () =>
  scenario(Effect.gen(function* () {
    const emulator = yield* printer()
    const session = yield* ready(emulator, "control")

    yield* session.send(Command.ChangeFilament({ target: AmsSlot.make({ ams: 1, slot: 3 }), currentTemperature: 220, targetTemperature: 230 }))
    assert.equal((yield* emulator.awaitRequest("ams_change_filament")).body.target, 7)

    yield* session.send(Command.SetBedTemperature({ celsius: 55 }))
    assert.equal((yield* emulator.awaitRequest("gcode_line")).body.param, "M140 S55\n")

    yield* emulator.update({ fun: (1n << 39n).toString(16) })
    yield* until(Effect.map(session.state.get, (state) => Predicate.isTagged(state.hardware.capabilities, "Present")))
    yield* session.send(Command.SetBedTemperature({ celsius: 60 }))
    assert.equal((yield* emulator.awaitRequest("set_bed_temp")).body.temp, 60)
  })))

test("rule 9: a tray without tray_color stays missing through the session, and filam_bak stays the firmware's", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer({
    report: { ams: { ams_exist_bits: "1", ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA" }] }] }, filam_bak: [1] }
  })

  const session = yield* ready(emulator, "control")
  const units = (yield* session.state.get).ams.units

  assert.ok(Predicate.isTagged(units, "Present"))

  const trays = units.value.get("0")?.trays

  assert.ok(trays !== undefined && Predicate.isTagged(trays, "Present"))
  assert.deepEqual(trays.value.get("0")?.color, Reading.Unknown())

  yield* session.send(startPrint("77", [AmsSlot.make({ ams: 0, slot: 0 })]), { beforePublish: Effect.void, onPublished: Effect.void })
  assert.equal(JSON.stringify((yield* emulator.awaitRequest("project_file")).body).includes("filam_bak"), false)
})))

test("rule 10: the default CommandSigner signs nothing; a signer, when provided, sees every request before it is written", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()

  const signed = Layer.succeed(CommandSigner, {
    signs: true,
    sign: (encoded) => Effect.succeed({ ...encoded, payload: { ...encoded.payload, header: { signed: "test" } } })
  })

  yield* ready(emulator, "control")
  assert.equal(JSON.stringify((yield* emulator.awaitRequest("get_version")).body).includes("sign"), false)

  const other = yield* printer()

  yield* ready(other, "control").pipe(Effect.provide(signed))

  const trace = yield* other.trace

  assert.ok(trace.some((entry) => entry.frame.dir === "tx" && "frame" in entry.frame && entry.frame.frame.header !== undefined))
})))

// Silence, reconnects and faults, all on TestClock.

test("awaitSilence completes after the duration with nothing heard, and keep-alive then ends the epoch", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "observe")
  const silence = yield* Effect.forkScoped(session.awaitSilence("45 seconds"))

  yield* emulator.inject(Fault.Silence())
  yield* advance("40 seconds")
  assert.equal(yield* stillPending(silence), true)
  yield* advance("10 seconds")
  yield* within(Fiber.join(silence))
  // The client's PINGREQ goes 45 s after its last write; the PINGRESP deadline is one 60 s period after that.
  yield* advance("80 seconds", "5 seconds")
  yield* within(waitForStatus(session, "EpochEnded"))

  const after = yield* Effect.flip(session.awaitSilence("1 second"))

  assert.ok(Predicate.isTagged(after, "SessionClosed"))
})))

test("awaitSilence restarts on every report", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()
  const session = yield* ready(emulator, "observe")
  const silence = yield* Effect.forkScoped(session.awaitSilence("10 seconds"))

  // The P1S profile pushes a partial report every 4 s, so silence never reaches 10 s.
  yield* advance("60 seconds")
  assert.equal(yield* stillPending(silence), true)
})))

test("awaitSilence does not elapse while the link is down: a stalled SUBACK never counts as silence", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()

  yield* emulator.inject(Fault.StallSuback())

  const session = yield* connectTo(emulator, "observe")
  const silence = yield* Effect.forkScoped(session.awaitSilence("45 seconds"))

  yield* advance("120 seconds", "5 seconds")
  assert.equal(yield* stillPending(silence), true)
  assert.deepEqual(yield* emulator.requests, [])
})))

test("a refused connection fails open, and a half-close or malformed report is handled", () => scenario(Effect.gen(function* () {
  const emulator = yield* printer()

  yield* emulator.inject(Fault.RefuseAuth({ code: 5 }))

  const refused = yield* Effect.flip(connectTo(emulator, "observe"))

  assert.ok(Predicate.isTagged(refused, "LinkError"))
  assert.match(refused.message, /ConnectionRefused/)
  yield* emulator.clear

  const session = yield* ready(emulator, "observe")

  yield* emulator.inject(Fault.Malformed())
  yield* emulator.update({ wifi_signal: "-33dBm" })
  yield* until(Effect.map(session.state.get, (state) => Predicate.isTagged(state.network.wifiSignal, "Present") && state.network.wifiSignal.value === "-33dBm"))

  yield* emulator.inject(Fault.Disconnect({ mode: "half-close" }))
  yield* within(waitForStatus(session, "EpochEnded"))
})))

// Compile-time rules for the session. This function never runs; `tsc` checks every `@ts-expect-error` below.
export const sessionTypeRules = (control: PrinterSession<"control">, observe: PrinterSession<"observe">) => {
  // @ts-expect-error A Start Print cannot compile without its publication hooks.
  control.send(startPrint("1"))

  // @ts-expect-error An observe session cannot send a Start Print.
  observe.send(startPrint("1"), { beforePublish: Effect.void, onPublished: Effect.void })

  // @ts-expect-error An observe session cannot move a motor.
  observe.send(Command.Pause())

  return [control.send(Command.Pause()), observe.send(Command.PushAll())]
}

