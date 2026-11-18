import assert from "node:assert/strict"
import { Predicate, Result, Schema } from "effect"
import { modelIds } from "@printhive/bambu-models"
import {
  AmsSlot,
  Command,
  CommandSigner,
  correlate,
  dialects,
  encode,
  ExternalSpool,
  Fact,
  protocol,
  sequenceId,
  TaskId,
  trayIndex,
  unknownDialect
} from "../src/protocol/index.ts"
import type { AmsMapping, CommandTag, Dialect, ReadOnlyCommand, EncodeContext, Encoded, Pending } from "../src/protocol/index.ts"
import { features } from "../src/provisional/index.ts"
import { test } from "./support/harness.ts"

const context = (dialect: Dialect, sequence = 7, capabilities?: string): EncodeContext => ({ dialect, sequenceId: sequenceId(sequence), capabilities })

const encoded = (result: Result.Result<Encoded, string>): Encoded => Result.match(result, {
  onSuccess: (value) => value,
  onFailure: (reason) => assert.fail(reason)
})

const print = (value: Encoded): Schema.JsonObject => {
  const body = value.payload.print

  return Schema.is(Schema.JsonObject)(body) ? body : assert.fail("expected a print body")
}

const defaultMapping: AmsMapping = [AmsSlot.make({ ams: 1, slot: 2 }), undefined, ExternalSpool.make({ id: 254 })]

const startPrint = (taskId = "123", amsMapping = defaultMapping) => Command.ProjectFile({
  taskId: Schema.decodeSync(TaskId)(taskId),
  subtaskName: "part",
  file: { url: "file:///sdcard/part.3mf", name: "part.3mf" },
  plate: 1,
  amsMapping,
  options: { timelapse: false, bedLevelling: true, flowCalibration: false, vibrationCalibration: false, layerInspect: false }
})

const pending = <T extends CommandTag>(command: Extract<Command, { readonly _tag: T }>, encodeContext: EncodeContext): Pending<T> => ({
  command,
  context: encodeContext,
  encoded: encoded(encode(command, encodeContext))
})

test("rule 1: Start Print pins sequence_id 50000 and sends task_id as a string", () => {
  for (const sequence of [0, 7, 49_999]) {
    const body = print(encoded(encode(startPrint("123"), context(dialects.P1S, sequence))))

    assert.equal(body.sequence_id, "50000")
    assert.equal(body.command, "project_file")
    assert.equal(body.task_id, "123")
    assert.equal(body.param, "Metadata/plate_1.gcode")
  }
})

test("rule 1: a Start Print ack is matched by task_id, not by sequence", () => {
  const sent = pending(startPrint("123"), context(dialects.P1S))

  assert.equal(correlate(sent, { print: { command: "project_file", sequence_id: "50000", task_id: "999", result: "success" } }), undefined)

  const outcome = correlate(sent, { print: { command: "project_file", sequence_id: "1", task_id: "123", result: "success" } })

  assert.ok(outcome !== undefined && Predicate.isTagged(outcome, "Acknowledged"))
  assert.ok(Predicate.isTagged(correlate(sent, { print: { command: "project_file", task_id: 123, result: "failed", reason: "busy" } }), "Rejected"))
})

test("rule 2: a LAN stop carries no job_id", () => {
  const body = print(encoded(encode(Command.Stop(), context(dialects.P1S))))

  assert.deepEqual(body, { sequence_id: "7", command: "stop" })
})

test("rule 2: a stop ack is only an Ack, which carries no execution state", () => {
  const sent = pending(Command.Stop(), context(dialects.P1S))
  const outcome = correlate(sent, { print: { command: "stop", sequence_id: "7", result: "success", reason: "success" } })

  assert.ok(outcome !== undefined && Predicate.isTagged(outcome, "Acknowledged"))
  assert.deepEqual(Object.keys(outcome.reply).sort(), ["reason", "report"])
})

test("pushall, pause and resume encode exactly as the P1S tape sent them", () => {
  const frames = [
    [Command.GetVersion(), 0, { info: { sequence_id: "0", command: "get_version" } }],
    [Command.PushAll(), 1, { pushing: { sequence_id: "1", command: "pushall" } }],
    [Command.Pause(), 2, { print: { sequence_id: "2", command: "pause" } }],
    [Command.Resume(), 3, { print: { sequence_id: "3", command: "resume" } }]
  ] as const

  for (const [command, sequence, frame] of frames) assert.deepEqual(encoded(encode(command, context(dialects.P1S, sequence))).payload, frame)
})

test("sequence correlation needs the same command and sequence id, and a failed result is a rejection", () => {
  const sent = pending(Command.Pause(), context(dialects.P1S, 2))

  assert.equal(correlate(sent, { print: { command: "resume", sequence_id: "2", result: "success" } }), undefined)
  assert.equal(correlate(sent, { print: { command: "pause", sequence_id: "3", result: "success" } }), undefined)
  assert.ok(Predicate.isTagged(correlate(sent, { print: { command: "pause", sequence_id: "2", result: "success" } }), "Acknowledged"))

  const rejected = correlate(sent, { print: { command: "pause", sequence_id: "2", result: "failed", reason: "" } })

  assert.ok(rejected !== undefined && Predicate.isTagged(rejected, "Rejected"))
  assert.equal(rejected.reason, "failed")
})

test("pushall is answered by the next full report, not by its sequence id (P1S tape)", () => {
  const sent = pending(Command.PushAll(), context(dialects.P1S, 1))

  assert.equal(correlate(sent, { print: { command: "push_status", msg: 1, sequence_id: "1", wifi_signal: "-28dBm" } }), undefined)

  const outcome = correlate(sent, { print: { command: "push_status", msg: 0, sequence_id: "38551", gcode_state: "FINISH" } })

  assert.ok(outcome !== undefined && Predicate.isTagged(outcome, "Acknowledged"))
  assert.ok(Fact.isVerified(outcome.reply.rule))
})

test("rule 5: an X1C get_version reply carries sequence_id 2021, and other models echo theirs", () => {
  const x1c = pending(Command.GetVersion(), context(dialects.X1C, 0))
  const p1s = pending(Command.GetVersion(), context(dialects.P1S, 0))
  const fixed = { info: { command: "get_version", sequence_id: "2021", module: [] } }
  const echoed = { info: { command: "get_version", sequence_id: "0", module: [], result: "success" } }

  assert.ok(Predicate.isTagged(correlate(x1c, fixed), "Acknowledged"))
  assert.equal(correlate(x1c, echoed), undefined)
  assert.ok(Predicate.isTagged(correlate(p1s, echoed), "Acknowledged"))
  assert.equal(correlate(p1s, fixed), undefined)
  assert.ok(Fact.isVerified(dialects.P1S.getVersionSequence))
  assert.equal(Fact.isVerified(dialects.X1C.getVersionSequence), false)
})

test("rule 5: P1, A1 and A2L repeat pushall every 5 minutes; an X1 pushes on its own", () => {
  for (const id of ["P1S", "P1P", "A1", "A1M", "A2L"] as const) assert.deepEqual(dialects[id].pushall.value, { every: 300_000 })

  for (const id of ["X1", "X1C", "X1E"] as const) assert.equal(dialects[id].pushall.value, "self-pushing")

  assert.equal(dialects.P1S.settleAfterSubscribe.value, 2_000)
  // A 13-line idle tape cannot verify a 5-minute cadence (synthesis red flag 4).
  assert.equal(Fact.isVerified(dialects.P1S.pushall), false)
})

test("rule 9: a load target is ams*4+slot, and external spools are 254 and 255", () => {
  assert.equal(trayIndex(AmsSlot.make({ ams: 0, slot: 0 })), 0)
  assert.equal(trayIndex(AmsSlot.make({ ams: 2, slot: 3 })), 11)
  assert.equal(trayIndex(ExternalSpool.make({ id: 254 })), 254)
  assert.equal(trayIndex(ExternalSpool.make({ id: 255 })), 255)
  assert.throws(() => AmsSlot.make({ ams: 0, slot: 4 }))

  const change = (id: 254 | 255, dialect: Dialect) =>
    encode(Command.ChangeFilament({ target: ExternalSpool.make({ id }), currentTemperature: 220, targetTemperature: 250 }), context(dialect))

  assert.deepEqual(print(encoded(change(254, dialects.P1S))), { sequence_id: "7", command: "ams_change_filament", target: 254, curr_temp: 220, tar_temp: 250 })
  assert.equal(print(encoded(change(255, dialects.H2D))).target, 255)
  // The P1S tape shows one external spool, 254, so 255 is refused before anything is written.
  assert.ok(Result.isFailure(change(255, dialects.P1S)))
})

test("rule 9: use_ams and the mapping fields differ by model, and H2D and H2S use the pair format", () => {
  const p1s = print(encoded(encode(startPrint(), context(dialects.P1S))))
  const h2d = print(encoded(encode(startPrint(), context(dialects.H2D))))

  assert.equal(p1s.use_ams, true)
  assert.deepEqual(p1s.ams_mapping, [6, -1, 254])
  assert.equal(p1s.ams_mapping2, undefined)
  assert.deepEqual(h2d.ams_mapping, [6, -1, 254])
  assert.deepEqual(h2d.ams_mapping2, [{ ams_id: 1, slot_id: 2 }, { ams_id: 255, slot_id: 255 }, { ams_id: 254, slot_id: 0 }])
  assert.equal(dialects.H2S.mappingFormat.value, "ams_mapping2")
  // Nothing in the clean room shows the pair format, so it must stay unverified.
  assert.equal(Fact.isVerified(dialects.H2D.mappingFormat), false)

  const externalOnly = startPrint("123", [ExternalSpool.make({ id: 254 })])

  assert.equal(print(encoded(encode(externalOnly, context(dialects.P1S)))).use_ams, false)
})

test("rule 9: filam_bak is owned by the firmware, so no command writes it", () => {
  const commands: ReadonlyArray<Command> = [
    Command.PushAll(),
    Command.GetVersion(),
    Command.Pause(),
    Command.Resume(),
    Command.Stop(),
    startPrint(),
    Command.ChangeFilament({ target: AmsSlot.make({ ams: 0, slot: 1 }), currentTemperature: 220, targetTemperature: 220 }),
    Command.SetBedTemperature({ celsius: 60 })
  ]

  assert.deepEqual(new Set(commands.map((command) => command._tag)), new Set(Object.keys(protocol)))

  for (const command of commands) assert.equal(JSON.stringify(encoded(encode(command, context(dialects.H2D)))).includes("filam_bak"), false)
})

test("rule 9: fun holds capability bits, and bit 39 chooses set_bed_temp over M140", () => {
  const bed = (capabilities: string | undefined) => print(encoded(encode(Command.SetBedTemperature({ celsius: 60 }), context(dialects.X1C, 7, capabilities))))

  assert.deepEqual(bed(undefined), { sequence_id: "7", command: "gcode_line", param: "M140 S60\n" })
  // pybambu's X1C mock reports 11A30F9CFB: bit 39 is clear.
  assert.equal(bed("11A30F9CFB").command, "gcode_line")
  assert.deepEqual(bed((1n << 39n).toString(16)), { sequence_id: "7", command: "set_bed_temp", temp: 60 })
  assert.equal(bed("not-hex").command, "gcode_line")
  assert.equal(Fact.isVerified(Fact.inferred(39, "bit")), false)
  assert.ok(Result.isFailure(encode(Command.SetBedTemperature({ celsius: 60.5 }), context(dialects.X1C))))
})

test("rule 10: Vortek, timelapse storage and signed commands are provisional and never verified", () => {
  for (const feature of Object.values(features)) {
    assert.equal(feature.value, "provisional")
    assert.equal(Fact.isVerified(feature), false)
    assert.match(Fact.label(feature), /^UNVERIFIED/)
  }

  assert.equal(CommandSigner.defaultValue().signs, false)

  for (const tag of Object.keys(protocol)) assert.doesNotMatch(tag, /vortek|timelapse|sign/i)
})

test("only PushAll and GetVersion are read-only", () => {
  assert.deepEqual(Object.entries(protocol).flatMap(([tag, row]) => (row.access === "observe" ? [tag] : [])).sort(), ["GetVersion", "PushAll"])
})

test("every registry model has a dialect that declares every command", () => {
  for (const id of modelIds) {
    const dialect = dialects[id]

    assert.equal(dialect.model, id)
    assert.deepEqual(Object.keys(dialect.commands).sort(), Object.keys(protocol).sort())
  }

  assert.equal(unknownDialect.model, undefined)
})

test("only facts read from a tape are verified, and each one names the P1S tape", () => {
  const facts = Object.values(dialects).flatMap((dialect): ReadonlyArray<Fact.Fact<unknown>> => [
    dialect.settleAfterSubscribe,
    dialect.pushall,
    dialect.getVersionSequence,
    dialect.fullReport,
    dialect.externalSpools,
    dialect.mappingFormat,
    dialect.commandTimeout,
    ...Object.values(dialect.commands)
  ])

  for (const fact of facts.filter((fact) => Fact.isVerified(fact))) assert.match(fact.ref, /^p1s-01\.09\.00\.00\/idle-2026-09-18\.jsonl /)

  assert.deepEqual(
    Object.entries(dialects.P1S.commands).flatMap(([tag, fact]) => (Fact.isVerified(fact) ? [tag] : [])).sort(),
    ["GetVersion", "Pause", "PushAll", "Resume"]
  )
})

test("a command a dialect does not support is refused before anything is written", () => {
  const dialect: Dialect = { ...dialects.P1S, commands: { ...dialects.P1S.commands, Stop: Fact.inferred("unsupported", "test") } }
  const result = encode(Command.Stop(), context(dialect))

  assert.ok(Result.isFailure(result))
  assert.match(result.failure, /Stop unsupported/)
})

// Compile-time rules. This function never runs; `tsc` checks every `@ts-expect-error` below.
export const typeRules = () => {
  // @ts-expect-error Stop has no fields, so a job_id cannot reach the wire (rule 2).
  Command.Stop({ job_id: "1" })

  // @ts-expect-error ProjectFile pins its own sequence id; a caller cannot set one (rule 1).
  Command.ProjectFile({ ...startPrintFields, sequenceId: "1" })

  // @ts-expect-error ProjectFile chooses its own correlation; a caller cannot set one (rule 1).
  Command.ProjectFile({ ...startPrintFields, correlation: "sequence" })

  // @ts-expect-error task_id is a branded digit string, not a number (rule 1).
  Command.ProjectFile({ ...startPrintFields, taskId: 123 })

  // Only PushAll and GetVersion are read-only, so an observe session can send nothing else.
  const readOnly: ReadonlyArray<ReadOnlyCommand> = [Command.PushAll(), Command.GetVersion()]

  // @ts-expect-error Pause moves a motor; it is not a read-only command.
  const pause: ReadOnlyCommand = Command.Pause()

  // @ts-expect-error A Fact built from a non-tape source is never Verified (rule 10).
  const verified: Fact.Verified<"provisional"> = features.vortek

  return [verified, readOnly, pause]
}

const startPrintFields = {
  taskId: Schema.decodeSync(TaskId)("1"),
  subtaskName: "part",
  file: { url: "file:///sdcard/part.3mf", name: "part.3mf" },
  plate: 1,
  amsMapping: [],
  options: { timelapse: false, bedLevelling: true, flowCalibration: false, vibrationCalibration: false, layerInspect: false }
}
