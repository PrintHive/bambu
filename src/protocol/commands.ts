import { Data, Predicate, Result, Schema } from "effect"
import { capabilityBit, capabilityFacts, encodeMapping, ExternalSpool, FilamentTarget, trayIndex } from "./ams.ts"
import type { AmsMapping } from "./ams.ts"
import type { Dialect } from "./dialect.ts"
import * as Outcome from "./outcome.ts"
import { SequenceId } from "../wire/ids.ts"
import { isObject } from "../wire/report.ts"
import * as Fact from "./provenance.ts"

/** `observe` sessions may send only read-only commands; `control` sessions may send any. */
export type Access = "observe" | "control"

/** A cloud or LAN task id. The wire carries it as a string of digits (proposal rule 1). */
export const TaskId = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(Schema.brand("TaskId"))

export type TaskId = typeof TaskId.Type

export interface PrintOptions {
  readonly timelapse: boolean
  readonly bedLevelling: boolean
  readonly flowCalibration: boolean
  readonly vibrationCalibration: boolean
  readonly layerInspect: boolean
}

/** A print file already on the printer: `url` is where it is, such as `file:///sdcard/part.3mf`. */
export interface RemoteFile {
  readonly url: string
  readonly name: string
  readonly md5?: string
}

/** The reply to a command matched by its sequence id or task id. An ack proves receipt, not effect. */
export interface Ack {
  readonly reason: string | undefined
  readonly report: Schema.JsonObject
}

/**
 * The first full report after a `pushall`. The P1S answers with a `push_status` under its own sequence id, not an
 * echo, so the match rests on the dialect's full-report rule; `rule` says which one and how sure it is.
 */
export interface FullReport {
  readonly report: Schema.JsonObject
  readonly rule: Dialect["fullReport"]
}

export interface VersionReply {
  readonly sequenceId: string
  readonly report: Schema.JsonObject
}

export type Correlation = "sequence" | "task-id" | "full-report" | "get-version"

export interface EncodeContext {
  readonly dialect: Dialect
  readonly sequenceId: SequenceId
  /** The printer's `print.fun` capability mask, if it has reported one. */
  readonly capabilities: string | undefined
}

/** The request as written: its category and wire command, the sequence id it carries, and the JSON body. */
export interface Encoded {
  readonly category: "print" | "info" | "pushing"
  readonly command: string
  readonly sequenceId: string
  readonly payload: Schema.JsonObject
}

interface Row<P, R, A extends Access = Access> {
  readonly access: A
  readonly correlation: Correlation
  readonly encode: (payload: P, context: EncodeContext) => Result.Result<Encoded, string>
  readonly reply: (report: Schema.JsonObject, context: EncodeContext) => R
}

const row = <P, R, const A extends Access>(spec: Row<P, R, A>): Row<P, R, A> => spec

const body = (category: Encoded["category"], command: string, sequenceId: string, fields: Schema.JsonObject): Encoded => ({
  category,
  command,
  sequenceId,
  payload: { [category]: { sequence_id: sequenceId, command, ...fields } }
})

const ack = (report: Schema.JsonObject): Ack => {
  const reason = [report.print, report.info, report.pushing].find(isObject)?.reason

  return { reason: Predicate.isString(reason) ? reason : undefined, report }
}

/** `project_file` always carries this sequence id. Its reply is matched by task id instead (proposal rule 1). */
export const projectFileSequenceId = "50000"

export const projectFileFacts = {
  sequenceId: Fact.inferred(projectFileSequenceId, "proposal rule 1: Start Print pins sequence_id at 50000"),
  correlation: Fact.inferred("task-id", "proposal rule 1: the ack is matched by task_id, not by sequence"),
  fields: Fact.inferred("project_file fields", "OpenBambuAPI mqtt.md print.project_file (factual tier); no tape has a Start Print")
} as const

const control = <P>(command: string, fields: (payload: P, context: EncodeContext) => Result.Result<Schema.JsonObject, string>): Row<P, Ack, "control"> => row({
  access: "control",
  correlation: "sequence",
  encode: (payload, context) => Result.map(fields(payload, context), (extra) => body("print", command, context.sequenceId, extra)),
  reply: ack
})

// The P1S tape sends pause and resume with only sequence_id and command, and both are acknowledged.
const plain = {}

/**
 * The protocol table. It is the only place a command is defined: the `Command` union, its constructors, the reply
 * types and the access rule all come from it.
 */
export const protocol = {
  PushAll: row<{}, FullReport, "observe">({
    access: "observe",
    correlation: "full-report",
    // The P1S tape sends only sequence_id and command, and gets its full report. OpenBambuAPI also lists
    // version and push_target; the tape shows they are not needed.
    encode: (_, { sequenceId }) => Result.succeed(body("pushing", "pushall", sequenceId, {})),
    reply: (report, { dialect }) => ({ report, rule: dialect.fullReport })
  }),
  GetVersion: row<{}, VersionReply, "observe">({
    access: "observe",
    correlation: "get-version",
    encode: (_, { sequenceId }) => Result.succeed(body("info", "get_version", sequenceId, {})),
    reply: (report) => {
      const sequenceId = isObject(report.info) ? report.info.sequence_id : undefined

      return { sequenceId: Predicate.isString(sequenceId) ? sequenceId : "", report }
    }
  }),
  Pause: control<{}>("pause", () => Result.succeed(plain)),
  Resume: control<{}>("resume", () => Result.succeed(plain)),
  // A LAN stop never carries job_id: with one, the firmware cancels a cloud task and still acks success (rule 2).
  Stop: control<{}>("stop", () => Result.succeed(plain)),
  ProjectFile: row<ProjectFilePayload, Ack, "control">({
    access: "control",
    correlation: "task-id",
    encode: ({ taskId, file, plate, amsMapping, options, subtaskName }, context) => Result.map(checkMapping(amsMapping, context.dialect), () =>
      body("print", "project_file", projectFileSequenceId, {
        param: `Metadata/plate_${plate}.gcode`,
        project_id: "0",
        profile_id: "0",
        task_id: taskId,
        subtask_id: "0",
        subtask_name: subtaskName,
        url: file.url,
        file: file.name,
        md5: file.md5 ?? "",
        timelapse: options.timelapse,
        bed_type: "auto",
        bed_levelling: options.bedLevelling,
        flow_cali: options.flowCalibration,
        vibration_cali: options.vibrationCalibration,
        layer_inspect: options.layerInspect,
        ...encodeMapping(amsMapping, context.dialect.mappingFormat.value)
      })),
    reply: ack
  }),
  ChangeFilament: control<ChangeFilamentPayload>("ams_change_filament", ({ target, currentTemperature, targetTemperature }, { dialect }) =>
    Result.map(checkTarget(target, dialect), () => ({ target: trayIndex(target), curr_temp: currentTemperature, tar_temp: targetTemperature }))),
  SetBedTemperature: row<SetBedTemperaturePayload, Ack, "control">({
    access: "control",
    correlation: "sequence",
    encode: ({ celsius }, { sequenceId, capabilities }) => {
      if (!Number.isInteger(celsius) || celsius < 0 || celsius > 120) return Result.fail(`bed temperature ${celsius} is not a whole number from 0 to 120`)

      const native = capabilities === undefined ? false : capabilityBit(capabilities, capabilityFacts.setBedTempBit.value) === true

      return Result.succeed(native
        ? body("print", "set_bed_temp", sequenceId, { temp: celsius })
        : body("print", "gcode_line", sequenceId, { param: `M140 S${celsius}\n` }))
    },
    reply: ack
  })
} satisfies Record<string, Row<never, unknown>>

export interface ProjectFilePayload {
  readonly taskId: TaskId
  readonly subtaskName: string
  readonly file: RemoteFile
  /** The plate number in the project, from 1. */
  readonly plate: number
  readonly amsMapping: AmsMapping
  readonly options: PrintOptions
}

export interface ChangeFilamentPayload {
  readonly target: FilamentTarget
  readonly currentTemperature: number
  readonly targetTemperature: number
}

export interface SetBedTemperaturePayload {
  readonly celsius: number
}

const checkTarget = (target: FilamentTarget, dialect: Dialect): Result.Result<void, string> => {
  if (!Schema.is(FilamentTarget)(target)) return Result.fail("the filament target is not an AMS slot or an external spool")

  if (Schema.is(ExternalSpool)(target) && !dialect.externalSpools.value.includes(target.id)) {
    return Result.fail(`${dialect.model ?? "this printer"} has no external spool ${target.id} (${Fact.label(dialect.externalSpools)})`)
  }

  return Result.succeed(undefined)
}

const checkMapping = (mapping: AmsMapping, dialect: Dialect): Result.Result<void, string> => {
  for (const target of mapping) {
    if (target === undefined) continue

    const checked = checkTarget(target, dialect)

    if (Result.isFailure(checked)) return checked
  }

  return Result.succeed(undefined)
}

type Protocol = typeof protocol

export type CommandTag = keyof Protocol

type PayloadOf<T extends CommandTag> = Protocol[T] extends Row<infer P, unknown> ? P : never

/** Every command the package can send. Generated from `protocol`. */
export type Command = Data.TaggedEnum<{ [T in CommandTag]: PayloadOf<T> }>

export const Command = Data.taggedEnum<Command>()

export type CommandOf<T extends CommandTag> = Extract<Command, { readonly _tag: T }>

export type ProjectFile = CommandOf<"ProjectFile">

type ReplyOfTag<T extends CommandTag> = Protocol[T] extends Row<never, infer R> ? R : never

/** The reply a command's `Acknowledged` outcome carries. */
export type ReplyOf<C extends Command> = ReplyOfTag<C["_tag"]>

type ReadOnlyTag = { [T in CommandTag]: Protocol[T] extends Row<never, unknown, "observe"> ? T : never }[CommandTag]

/** The commands an `observe` session may send. */
export type ReadOnlyCommand = CommandOf<ReadOnlyTag>

export type Allowed<X extends Access> = X extends "observe" ? ReadOnlyCommand : Command

type Rows = { readonly [T in CommandTag]: Row<CommandOf<T>, ReplyOfTag<T>> }

const rows: Rows = protocol

const rowOf = <T extends CommandTag>(tag: T): Rows[T] => rows[tag]

export const accessOf = (command: Command): Access => protocol[command._tag].access

export const correlationOf = (command: Command): Correlation => protocol[command._tag].correlation

/** Encodes a command, or explains why it cannot be encoded for this dialect. Nothing is written either way. */
export const encode = <T extends CommandTag>(command: CommandOf<T>, context: EncodeContext): Result.Result<Encoded, string> => {
  const support = context.dialect.commands[command._tag]

  if (support.value !== "supported") {
    return Result.fail(`${context.dialect.model ?? "this printer"} marks ${command._tag} ${support.value} (${Fact.label(support)})`)
  }

  return rowOf<T>(command._tag).encode(command, context)
}

const text = (value: Schema.Json | undefined): string | undefined =>
  Predicate.isString(value) ? value : Predicate.isNumber(value) ? String(value) : undefined

/** The pending request a reply is matched against. */
export interface Pending<T extends CommandTag = CommandTag> {
  readonly command: CommandOf<T>
  readonly encoded: Encoded
  readonly context: EncodeContext
}

/** What a reply is matched against: the request as written and the dialect it was written for. */
type Sent = Pick<Pending, "encoded" | "context">

const matchers = {
  sequence: ({ encoded }, report) => {
    const reply = report[encoded.category]

    return isObject(reply) && reply.command === encoded.command && text(reply.sequence_id) === encoded.sequenceId
  },
  "task-id": ({ encoded }, report) => {
    const reply = report.print
    const sent = isObject(encoded.payload.print) ? encoded.payload.print.task_id : undefined

    return isObject(reply) && reply.command === "project_file" && text(reply.task_id) !== undefined && text(reply.task_id) === sent
  },
  "full-report": ({ context }, report) => {
    const reply = report.print

    if (!isObject(reply) || reply.command !== "push_status") return false

    return context.dialect.fullReport.value === "msg-0" ? reply.msg === 0 : reply.gcode_state !== undefined
  },
  "get-version": ({ encoded, context }, report) => {
    const reply = report.info
    const expected = context.dialect.getVersionSequence.value

    return isObject(reply) && reply.command === "get_version" &&
      text(reply.sequence_id) === (expected === "echo" ? encoded.sequenceId : expected.fixed)
  }
} satisfies { readonly [K in Correlation]: (sent: Sent, report: Schema.JsonObject) => boolean }

/**
 * Settles a pending command with a report, or returns undefined when the report is not its reply. A reply whose
 * `result` is present and not `success` (in any case) is a rejection.
 */
export const correlate = <T extends CommandTag>(pending: Pending<T>, report: Schema.JsonObject): Outcome.CommandOutcome<ReplyOfTag<T>> | undefined => {
  if (!matchers[protocol[pending.command._tag].correlation](pending, report)) return undefined

  const reply = report[pending.encoded.category === "pushing" ? "print" : pending.encoded.category]
  const result = isObject(reply) ? text(reply.result) : undefined

  if (result !== undefined && result.toLowerCase() !== "success") {
    const reason = isObject(reply) ? text(reply.reason) : undefined

    return Outcome.Rejected({ reason: reason === undefined || reason === "" ? result : reason, report })
  }

  return Outcome.Acknowledged({ reply: rowOf<T>(pending.command._tag).reply(report, pending.context) })
}

export const sequenceId = (value: number): SequenceId => Schema.decodeSync(SequenceId)(String(value))
