import { Buffer } from "node:buffer"
import type * as tls from "node:tls"
import { Clock, Context, Data, Effect, Layer, Option, Predicate, Ref, Schema, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import type { ModelId } from "@printhive/bambu-models"
import type { Publish, SubackCode } from "@printhive/mqtt/packet"
import { serve } from "@printhive/mqtt/server"
import type { CloseMode, ConnackCode, ServeError, ServerSession } from "@printhive/mqtt/server"
import * as Fact from "../protocol/provenance.ts"
import type { TapeFrame } from "../tape/format.ts"
import { isObject } from "../wire/report.ts"
import { describe, profiles } from "./profile.ts"
import type { Profile, Reply, WorldEffect } from "./profile.ts"

/**
 * A scripted fault. `Silence`, `RefuseAuth`, `StallSuback`, `IgnoreStop` and `DropReplies` last until `clear`.
 * `Disconnect` and `Malformed` happen once. `RejectNext` applies to the next request with that command.
 */
export type Fault = Data.TaggedEnum<{
  /** Mute every session, the server's own PINGRESP included: a printer gone silent with its socket open. */
  Silence: {}
  /** End every open session: `end` sends FIN, `half-close` stops writing but keeps reading, `destroy` drops it. */
  Disconnect: { readonly mode: CloseMode }
  /** Publish a report that is not JSON. */
  Malformed: {}
  /** Refuse every new connection with this CONNACK code. */
  RefuseAuth: { readonly code: Exclude<ConnackCode, 0> }
  /** Never send SUBACK. */
  StallSuback: {}
  /** Acknowledge a stop and change nothing. */
  IgnoreStop: {}
  /** Act on requests but publish no reply. */
  DropReplies: {}
  /** Reject the next request with this command. */
  RejectNext: { readonly command: string; readonly reason: string }
}>

export const Fault = Data.taggedEnum<Fault>()

export interface EmulatorOptions {
  readonly model: ModelId
  /** The serial the printer reports and serves under. */
  readonly serial: string
  /** The LAN access code; the MQTT password. */
  readonly accessCode: string
  /** A key and certificate for TLS on the loopback port. Without them the broker speaks plain TCP. */
  readonly tls?: tls.TlsOptions | undefined
  /** `ignore` never drops a silent client, which models a printer that never notices a half-open socket. */
  readonly keepAlive?: "enforce" | "ignore" | undefined
  /** Report fields to start from, over the profile's seed. */
  readonly report?: Schema.JsonObject | undefined
}

/**
 * One frame the emulator saw or sent, in tape form: `tx` was sent to the printer and `rx` came from it. `labels` are
 * the facts behind an `rx` frame, so output can say which behavior is UNVERIFIED.
 */
export interface TraceEntry {
  readonly frame: TapeFrame
  readonly labels: ReadonlyArray<string>
  readonly verified: boolean
}

export interface Request {
  readonly category: string
  readonly command: string
  readonly body: Schema.JsonObject
  readonly topic: string
}

export interface VirtualPrinter {
  readonly address: { readonly host: string; readonly port: number }
  readonly serial: string
  readonly profile: Profile
  /** Every fact the profile rests on, labelled VERIFIED or UNVERIFIED. */
  readonly describe: ReadonlyArray<string>
  readonly trace: Effect.Effect<ReadonlyArray<TraceEntry>>
  /** Waits for the `occurrence`th request with this wire command, counting from the start, and returns it. */
  readonly awaitRequest: (command: string, occurrence?: number) => Effect.Effect<Request>
  readonly requests: Effect.Effect<ReadonlyArray<Request>>
  /** How many sessions have connected since the start. */
  readonly sessionCount: Effect.Effect<number>
  /** Waits until at least `count` sessions have connected since the start. */
  readonly awaitSessions: (count: number) => Effect.Effect<void>
  /** Waits until a session holds a subscription to the report topic. */
  readonly awaitSubscribed: Effect.Effect<void>
  readonly world: Effect.Effect<Schema.JsonObject>
  /** Changes the printer's state, as the printer itself would, and reports the change. */
  readonly update: (patch: Schema.JsonObject) => Effect.Effect<void>
  readonly inject: (fault: Fault) => Effect.Effect<void>
  /** Lifts every lasting fault and unmutes every session. */
  readonly clear: Effect.Effect<void>
}

interface Faults {
  readonly silent: boolean
  readonly refuse: Exclude<ConnackCode, 0> | undefined
  readonly stallSuback: boolean
  readonly ignoreStop: boolean
  readonly dropReplies: boolean
  readonly rejectNext: ReadonlyMap<string, string>
}

const noFaults: Faults = { silent: false, refuse: undefined, stallSuback: false, ignoreStop: false, dropReplies: false, rejectNext: new Map() }

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))

const active = new Set(["PREPARE", "RUNNING", "PAUSE", "SLICING"])

const text = (value: Schema.Json | undefined): string | undefined =>
  Predicate.isString(value) ? value : Predicate.isNumber(value) ? String(value) : undefined

const withSerial = (modules: ReadonlyArray<Schema.JsonObject>, serial: string): ReadonlyArray<Schema.JsonObject> =>
  modules.map((module) => (module.name === "ota" || module.name === "esp32" ? { ...module, sn: serial } : module))

interface EffectInput {
  readonly world: Schema.JsonObject
  readonly state: string | undefined
  readonly body: Schema.JsonObject
  readonly faults: Faults
}

/** The emulator's own fold: a request's effect on the world, as the fields that change. */
const effects = {
  none: () => ({}),
  pause: ({ state }) => (state === "RUNNING" || state === "PREPARE" ? { gcode_state: "PAUSE" } : {}),
  resume: ({ state }) => (state === "PAUSE" ? { gcode_state: "RUNNING" } : {}),
  stop: ({ state, faults }) => (!faults.ignoreStop && state !== undefined && active.has(state) ? { gcode_state: "FAILED" } : {}),
  "start-print": ({ body }) => ({
    gcode_state: "PREPARE",
    task_id: text(body.task_id) ?? "0",
    subtask_name: text(body.subtask_name) ?? "",
    mc_percent: 0,
    print_error: 0
  }),
  "change-filament": ({ world, body }) => {
    const ams = isObject(world.ams) ? world.ams : {}
    const target = text(body.target)

    return target === undefined ? {} : { ams: { ...ams, tray_tar: target, tray_now: target } }
  },
  gcode: ({ body }) => {
    const bed = /M140 S(\d+)/.exec(text(body.param) ?? "")?.[1]

    return bed === undefined ? {} : { bed_target_temper: Number(bed) }
  },
  "set-bed": ({ body }) => (Predicate.isNumber(body.temp) ? { bed_target_temper: body.temp } : {})
} satisfies { readonly [K in WorldEffect]: (input: EffectInput) => Schema.JsonObject }

const effectOf = (effect: WorldEffect, world: Schema.JsonObject, body: Schema.JsonObject, faults: Faults): Schema.JsonObject =>
  effects[effect]({ world, state: text(world.gcode_state), body, faults })

/** A trace frame before its time is stamped. */
type Untimed = { readonly dir: "rx" | "tx"; readonly topic: string } & ({ readonly frame: Schema.JsonObject } | { readonly raw: string })

const labelsOf = (facts: ReadonlyArray<Fact.Fact<unknown>>) => ({
  labels: facts.map((fact) => Fact.label(fact)),
  verified: facts.every((fact) => Fact.isVerified(fact))
})

/** Runs an emulated printer on a loopback port until the scope closes. */
export const make = (options: EmulatorOptions): Effect.Effect<VirtualPrinter, ServeError, Scope.Scope> => Effect.gen(function* () {
  const profile = profiles[options.model]
  const { serial } = options
  const reportTopic = `device/${serial}/report`
  const requestTopic = `device/${serial}/request`
  const start = yield* Clock.currentTimeMillis
  const world = yield* Ref.make<Schema.JsonObject>({ ...profile.seed.value.report, ...options.report })
  const modules = withSerial(profile.seed.value.modules, serial)
  const faults = yield* Ref.make(noFaults)
  const sessions = yield* Ref.make<ReadonlySet<ServerSession>>(new Set())
  const connected = yield* SubscriptionRef.make(0)
  const subscribed = yield* SubscriptionRef.make(false)
  const requests = yield* SubscriptionRef.make<ReadonlyArray<Request>>([])
  const trace = yield* Ref.make<ReadonlyArray<TraceEntry>>([])
  const reportSequence = yield* Ref.make(1)

  const record = (untimed: Untimed, facts: ReadonlyArray<Fact.Fact<unknown>>) => Effect.flatMap(Clock.currentTimeMillis, (now) => {
    const frame: TapeFrame = { ...untimed, t: (now - start) / 1000 }

    return Ref.update(trace, (entries) => [...entries, { frame, ...labelsOf(facts) }])
  })

  const broadcast = (payload: string) => Effect.flatMap(Ref.get(sessions), (live) =>
    Effect.forEach(live, (session) => Effect.ignore(session.publish(reportTopic, payload)), { discard: true }))

  const send = (frame: Schema.JsonObject, facts: ReadonlyArray<Fact.Fact<unknown>>) =>
    Effect.andThen(record({ dir: "rx", topic: reportTopic, frame }, facts), broadcast(JSON.stringify(frame)))

  const nextSequence = Ref.getAndUpdate(reportSequence, (n) => n + 1)

  const fullReport = Effect.gen(function* () {
    const sequence = yield* nextSequence
    const body = yield* Ref.get(world)

    const envelope = { command: "push_status", sequence_id: String(sequence) }

    return { print: profile.fullReportMarker.value ? { ...body, ...envelope, msg: 0 } : { ...body, ...envelope } }
  })

  /** Reports changed fields the way the profile pushes: the changes alone, or the whole state. */
  const reportChange = (patch: Schema.JsonObject, facts: ReadonlyArray<Fact.Fact<unknown>>) => Effect.gen(function* () {
    if (Object.keys(patch).length === 0) return

    yield* Ref.update(world, (body) => ({ ...body, ...patch }))

    if ("fullEvery" in profile.pushing.value) return yield* send(yield* fullReport, [...facts, profile.pushing])

    const sequence = yield* nextSequence

    yield* send({ print: { ...patch, command: "push_status", msg: 1, sequence_id: String(sequence) } }, [...facts, profile.pushing])
  })

  const reply = (request: Request, faultsNow: Faults) => Effect.gen(function* () {
    const behavior = profile.commands[request.command]

    if (behavior === undefined || faultsNow.dropReplies) return

    const sequenceId = text(request.body.sequence_id) ?? ""
    const rejection = faultsNow.rejectNext.get(request.command)

    if (rejection !== undefined) {
      yield* Ref.update(faults, (current) => ({ ...current, rejectNext: new Map([...current.rejectNext].filter(([command]) => command !== request.command)) }))

      return yield* send({ [request.category]: { sequence_id: sequenceId, command: request.command, result: "failed", reason: rejection } }, [
        Fact.inferred("reject", "scripted fault RejectNext")
      ])
    }

    const replies = {
      silent: Effect.void,
      "full-report": Effect.flatMap(fullReport, (frame) => send(frame, [behavior.reply])),
      version: Effect.suspend(() => {
        const fixed = profile.versionSequence.value

        return send({
          info: { command: "get_version", sequence_id: fixed === "echo" ? sequenceId : fixed.fixed, module: modules, result: "success", reason: "" }
        }, [behavior.reply, profile.versionSequence])
      }),
      // project_file echoes its request, task_id included; other acks carry the envelope the P1S tape shows.
      ack: Effect.suspend(() => {
        const echo = request.command === "project_file" ? request.body : { sequence_id: sequenceId, command: request.command }

        return send({ [request.category]: { ...echo, reason: "success", result: "success" } }, [behavior.reply])
      })
    } satisfies { readonly [K in Reply]: Effect.Effect<void> }

    yield* replies[behavior.reply.value]
  })

  const startPrint = (taskId: string) => Effect.gen(function* () {
    yield* Effect.sleep(profile.prepareFor.value)

    const body = yield* Ref.get(world)

    if (body.gcode_state === "PREPARE" && text(body.task_id) === taskId) yield* reportChange({ gcode_state: "RUNNING" }, [profile.prepareFor])
  })

  const onRequest = (packet: Publish) => Effect.gen(function* () {
    const raw = Buffer.from(packet.payload).toString("utf8")
    const decoded = decodeRequest(raw)

    if (Option.isNone(decoded)) return yield* record({ dir: "tx", topic: packet.topic, raw }, [])

    yield* record({ dir: "tx", topic: packet.topic, frame: decoded.value }, [])

    if (packet.topic !== requestTopic) return

    const entry = Object.entries(decoded.value).find(([, value]) => isObject(value) && Predicate.isString(value.command))

    if (entry === undefined || !isObject(entry[1]) || !Predicate.isString(entry[1].command)) return

    const request: Request = { category: entry[0], command: entry[1].command, body: entry[1], topic: packet.topic }

    yield* SubscriptionRef.update(requests, (all) => [...all, request])

    const faultsNow = yield* Ref.get(faults)
    const behavior = profile.commands[request.command]
    const patch = behavior === undefined ? {} : effectOf(behavior.effect.value, yield* Ref.get(world), request.body, faultsNow)

    yield* reply(request, faultsNow)

    if (behavior !== undefined) yield* reportChange(patch, [behavior.effect])

    if (patch.gcode_state === "PREPARE" && Predicate.isString(patch.task_id)) yield* Effect.forkScoped(startPrint(patch.task_id))
  })

  const server = yield* serve({
    tls: options.tls,
    keepAlive: options.keepAlive ?? "enforce",
    // Bambu LAN mode: user bblp, password the access code.
    authenticate: (connect) => Effect.map(Ref.get(faults), ({ refuse }): ConnackCode => {
      if (refuse !== undefined) return refuse

      const password = connect.password === undefined ? undefined : Buffer.from(connect.password).toString("utf8")

      return connect.username === "bblp" && password === options.accessCode ? 0 : 5
    }),
    onSubscribe: (_, request) => Effect.flatMap(Ref.get(faults), ({ stallSuback }) => stallSuback
      ? Effect.never
      : Effect.as(
        request.subscriptions.some(({ filter }) => filter === reportTopic || filter === "device/+/report" || filter === "#")
          ? SubscriptionRef.set(subscribed, true) : Effect.void,
        request.subscriptions.map(({ qos }): SubackCode => qos)
      ))
  })

  const handle = (session: ServerSession) => Effect.gen(function* () {
    yield* Ref.update(sessions, (live) => new Set([...live, session]))
    yield* SubscriptionRef.update(connected, (count) => count + 1)

    if ((yield* Ref.get(faults)).silent) yield* session.mute(true)

    yield* session.inbound.pipe(
      Stream.runForEach((packet) => (Predicate.isTagged(packet, "Publish") ? onRequest(packet) : Effect.void)),
      Effect.ignore,
      Effect.ensuring(Ref.update(sessions, (live) => new Set([...live].filter((other) => other !== session))))
    )
  })

  yield* Effect.forkScoped(Stream.runForEach(server.sessions, (session) => Effect.forkScoped(handle(session))))

  const pushing = profile.pushing.value

  const tick = "fullEvery" in pushing
    ? Effect.flatMap(fullReport, (frame) => send(frame, [profile.pushing]))
    : Effect.gen(function* () {
      const sequence = yield* nextSequence
      const body = yield* Ref.get(world)

      yield* send({ print: { wifi_signal: body.wifi_signal ?? "-50dBm", command: "push_status", msg: 1, sequence_id: String(sequence) } }, [profile.pushing])
    })

  const period = "fullEvery" in pushing ? pushing.fullEvery : pushing.partialEvery

  yield* Effect.forkScoped(Effect.forever(Effect.delay(tick, period)))

  const unverified = describe(profile).filter((line) => line.includes("UNVERIFIED"))

  yield* Effect.logInfo(`bambu emulator ${profile.model}: ${unverified.length} of ${describe(profile).length} facts UNVERIFIED`)

  const inject = (fault: Fault): Effect.Effect<void> => Fault.$match(fault, {
    Silence: () => Effect.andThen(
      Ref.update(faults, (current) => ({ ...current, silent: true })),
      Effect.flatMap(Ref.get(sessions), (live) => Effect.forEach(live, (session) => session.mute(true), { discard: true }))
    ),
    Disconnect: ({ mode }) => Effect.flatMap(Ref.get(sessions), (live) => Effect.forEach(live, (session) => session.close(mode), { discard: true })),
    Malformed: () => Effect.andThen(
      record({ dir: "rx", topic: reportTopic, raw: "{\"print\":" }, [Fact.inferred("malformed", "scripted fault Malformed")]),
      Effect.flatMap(Ref.get(sessions), (live) => Effect.forEach(live, (session) => Effect.ignore(session.publish(reportTopic, "{\"print\":")), { discard: true }))
    ),
    RefuseAuth: ({ code }) => Ref.update(faults, (current) => ({ ...current, refuse: code })),
    StallSuback: () => Ref.update(faults, (current) => ({ ...current, stallSuback: true })),
    IgnoreStop: () => Ref.update(faults, (current) => ({ ...current, ignoreStop: true })),
    DropReplies: () => Ref.update(faults, (current) => ({ ...current, dropReplies: true })),
    RejectNext: ({ command, reason }) => Ref.update(faults, (current) => ({ ...current, rejectNext: new Map([...current.rejectNext, [command, reason]]) }))
  })

  const awaitRequest = (command: string, occurrence = 1): Effect.Effect<Request> => SubscriptionRef.changes(requests).pipe(
    Stream.map((all) => all.filter((request) => request.command === command)[occurrence - 1]),
    Stream.filter(Predicate.isNotUndefined),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.orDie
  )

  return {
    address: server.address,
    serial,
    profile,
    describe: describe(profile),
    trace: Ref.get(trace),
    awaitRequest,
    requests: SubscriptionRef.get(requests),
    sessionCount: SubscriptionRef.get(connected),
    awaitSessions: (count) => SubscriptionRef.changes(connected).pipe(Stream.filter((n) => n >= count), Stream.runHead, Effect.asVoid),
    awaitSubscribed: SubscriptionRef.changes(subscribed).pipe(Stream.filter(Boolean), Stream.runHead, Effect.asVoid),
    world: Ref.get(world),
    update: (patch) => reportChange(patch, [Fact.inferred("update", "a scenario changed the printer's state")]),
    inject,
    clear: Effect.andThen(
      Ref.set(faults, noFaults),
      Effect.flatMap(Ref.get(sessions), (live) => Effect.forEach(live, (session) => session.mute(false), { discard: true }))
    )
  } satisfies VirtualPrinter
})

/** The emulator as a service, for an Effect Layer. */
export class Emulator extends Context.Service<Emulator, VirtualPrinter>()("@printhive/bambu/emulator/Emulator") {}

/** An in-process emulator for tests: it binds a loopback port and closes with the layer. */
export const layer = (options: EmulatorOptions): Layer.Layer<Emulator, ServeError> => Layer.effect(Emulator, make(options))
