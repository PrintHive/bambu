import { Cause, Clock, Data, Deferred, Duration, Effect, Exit, Option, Predicate, PubSub, Queue, Result, Schema, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import { accessOf, Command, correlate, encode, sequenceId } from "../protocol/commands.ts"
import type { Access, EncodeContext, Encoded, Pending, ProjectFile, ReadOnlyCommand, ReplyOf } from "../protocol/commands.ts"
import { dialectFor } from "../protocol/dialect.ts"
import type { Dialect } from "../protocol/dialect.ts"
import { Ambiguous, NotSent, SessionClosed } from "../protocol/outcome.ts"
import type { AmbiguousCause, CommandOutcome, Refused } from "../protocol/outcome.ts"
import { CommandSigner } from "../protocol/signer.ts"
import * as Lifecycle from "../state/lifecycle.ts"
import { initialState, reduce } from "../state/reduce.ts"
import type { Delta, PrinterState } from "../state/reduce.ts"
import type { Link } from "./link.ts"

/**
 * Where the epoch is. `status` ends with `EpochEnded`, and nothing in a session outlives it: a caller that wants
 * another epoch opens another session.
 */
export type SessionStatus = Data.TaggedEnum<{
  /** Connected, waiting for the report subscription to be granted. */
  Subscribing: {}
  /** Subscribed; the handshake is under way. Commands wait until it is sent. */
  Handshaking: {}
  /** `get_version` and the first `pushall` are written; commands flow. */
  Ready: {}
  EpochEnded: { readonly reason: string }
}>

export const SessionStatus = Data.taggedEnum<SessionStatus>()

/** One reduced report: the new state, what changed, and the lifecycle events it proved. */
export interface StateChange {
  readonly state: PrinterState
  readonly delta: Delta
  readonly events: ReadonlyArray<Lifecycle.LifecycleEvent>
  readonly unclaimed: ReadonlyArray<string>
  readonly observedAt: number
}

/**
 * The two ADR-0056 phases. hive-link supplies both and closes over its own attempt reference; the package never
 * sees it. `beforePublish` is the last authority check: a failure means `NotSent`. `onPublished` runs once the
 * bytes are written.
 */
export interface PublishHooks {
  readonly beforePublish: Effect.Effect<void, Refused>
  readonly onPublished: Effect.Effect<void>
}

/** A read-only view of a value one fiber owns. */
export interface Observable<A> {
  readonly get: Effect.Effect<A>
  /** The current value, then every change. */
  readonly changes: Stream.Stream<A>
}

type Sent<C extends Command> = Effect.Effect<CommandOutcome<ReplyOf<C>>, NotSent | SessionClosed>

export interface ControlSend {
  /** A Start Print needs its publication hooks. */
  (command: ProjectFile, hooks: PublishHooks): Sent<ProjectFile>
  <C extends Exclude<Command, ProjectFile>>(command: C, hooks?: PublishHooks): Sent<C>
}

export interface ObserveSend {
  <C extends ReadOnlyCommand>(command: C, hooks?: PublishHooks): Sent<C>
}

export interface PrinterSession<X extends Access> {
  readonly access: X
  readonly status: Stream.Stream<SessionStatus>
  readonly state: Observable<PrinterState>
  readonly lifecycle: Effect.Effect<Lifecycle.Lifecycle>
  /** Every reduced report from now until the epoch ends. */
  readonly changes: Stream.Stream<StateChange>
  /**
   * Completes once nothing has arrived from the printer for `duration` while the link was up. Time before the
   * subscription is granted does not count, so a recycle cannot spin. Fails with `SessionClosed` once the epoch ends.
   */
  readonly awaitSilence: (duration: Duration.Input) => Effect.Effect<void, SessionClosed>
  /**
   * Sends a command. `NotSent` and `SessionClosed` mean no byte was written. Every outcome means the bytes left.
   * The session never resends anything.
   */
  readonly send: X extends "control" ? ControlSend : ObserveSend
  /** Ends the epoch. Commands already written resolve as `Ambiguous("connection-lost")`. */
  readonly close: Effect.Effect<void>
}

export interface SessionOptions<X extends Access> {
  readonly serial: string
  readonly access: X
  /** Continue from an earlier epoch's state and lifecycle. The lifecycle starts offline either way. */
  readonly previous?: { readonly state: PrinterState; readonly lifecycle: Lifecycle.Lifecycle } | undefined
}

const noHooks: PublishHooks = { beforePublish: Effect.void, onPublished: Effect.void }

interface Request {
  readonly command: Command
  readonly hooks: PublishHooks
  readonly done: Deferred.Deferred<CommandOutcome<unknown>, NotSent | SessionClosed>
  /** Set by the actor when it takes the request. A caller interrupted before then cancels it. */
  claimed: boolean
  cancelled: boolean
}

interface Waiting {
  readonly pending: Pending
  readonly done: Request["done"]
}

type Message = Data.TaggedEnum<{
  Subscribed: {}
  HandshakeDue: {}
  Report: { readonly payload: string }
  Send: { readonly request: Request }
  PushAllDue: {}
  TimedOut: { readonly id: number }
  Ended: { readonly reason: string }
}>

const Message = Data.taggedEnum<Message>()

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))

/** The link-up time from which silence counts, or undefined while the link is not up. */
interface Hearing {
  readonly since: number | undefined
  readonly ended: boolean
}

/**
 * Opens one connection epoch over `link`. One actor fiber owns the state, the pending commands, the sequence
 * allocator and the epoch, so a reply cannot arrive before its registration and nothing interleaves with a publish.
 */
export const fromLink = <X extends Access>(link: Link, options: SessionOptions<X>): Effect.Effect<PrinterSession<X>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const signer = yield* CommandSigner
    const mailbox = yield* Queue.unbounded<Message>()
    const first = options.previous?.state ?? initialState(options.serial)
    const state = yield* SubscriptionRef.make(first)
    const status = yield* SubscriptionRef.make<SessionStatus>(SessionStatus.Subscribing())
    const hearing = yield* SubscriptionRef.make<Hearing>({ since: undefined, ended: false })
    const changes = yield* PubSub.unbounded<StateChange>()
    const handshakeDialect = dialectFor(first.model?.id)

    // Actor-owned. Only the actor fiber reads or writes these.
    let lifecycle = Lifecycle.goOffline(options.previous?.lifecycle ?? Lifecycle.initial)
    let nextSequence = 0
    let nextId = 0
    let ready = false
    let ended: string | undefined
    const queued: Request[] = []
    const pending = new Map<number, Waiting>()

    const offer = (message: Message) => Effect.asVoid(Queue.offer(mailbox, message))

    const contextFor = (dialect: Dialect, current: PrinterState): EncodeContext => {
      const fun = current.hardware.capabilities

      return {
        dialect,
        sequenceId: sequenceId(nextSequence++),
        capabilities: Predicate.isTagged(fun, "Present") ? fun.value : undefined
      }
    }

    const settle = (id: number, outcome: CommandOutcome<unknown>) => Effect.suspend(() => {
      const waiting = pending.get(id)

      if (waiting === undefined) return Effect.void

      pending.delete(id)

      return Deferred.succeed(waiting.done, outcome)
    })

    /** Writes one request. Everything from `beforePublish` to `onPublished` is one uninterruptible step. */
    const publish = (request: Request) => Effect.gen(function* () {
      request.claimed = true

      if (ended !== undefined) return yield* Deferred.fail(request.done, new SessionClosed({ reason: ended }))

      const current = yield* SubscriptionRef.get(state)
      const context = contextFor(dialectFor(current.model?.id), current)
      const encoded = encode(request.command, context)

      if (Result.isFailure(encoded)) return yield* Deferred.fail(request.done, new NotSent({ reason: encoded.failure }))

      const signed: Encoded = yield* signer.sign(encoded.success)
      const id = nextId++

      const written = yield* Effect.uninterruptible(Effect.gen(function* () {
        const allowed = yield* Effect.exit(request.hooks.beforePublish)

        if (Exit.isFailure(allowed)) {
          const reason = Option.match(Cause.findErrorOption(allowed.cause), {
            onNone: () => "beforePublish failed",
            onSome: (refused) => `refused: ${refused.reason}`
          })

          yield* Deferred.fail(request.done, new NotSent({ reason }))

          return false
        }

        // Registered before the write; the actor reads no report until this step ends.
        pending.set(id, { pending: { command: request.command, encoded: signed, context }, done: request.done })

        const sent = yield* Effect.exit(link.publish(JSON.stringify(signed.payload)))

        if (Exit.isFailure(sent)) {
          pending.delete(id)
          yield* Deferred.fail(request.done, new NotSent({ reason: Cause.pretty(sent.cause) }))

          return false
        }

        const after = yield* Effect.exit(request.hooks.onPublished)

        if (Exit.isFailure(after)) yield* settle(id, Ambiguous({ cause: "publish-hook-failed" }))

        return true
      }))

      if (written && pending.has(id)) {
        yield* Effect.forkIn(Effect.delay(offer(Message.TimedOut({ id })), pending.get(id)?.pending.context.dialect.commandTimeout.value ?? 10_000), scope)
      }
    })

    const internal = (command: ReadOnlyCommand) => Effect.flatMap(
      Deferred.make<CommandOutcome<unknown>, NotSent | SessionClosed>(),
      (done) => publish({ command, hooks: noHooks, done, claimed: false, cancelled: false })
    )

    const onReport = (payload: string) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis

      yield* SubscriptionRef.update(hearing, (current) => (current.since === undefined ? current : { ...current, since: now }))

      const report = decodeReport(payload)

      // A payload that is not a JSON object is not evidence of anything; the link stays up.
      if (Option.isNone(report)) return

      const previous = yield* SubscriptionRef.get(state)
      const reduction = reduce(previous, report.value, now)
      const step = Lifecycle.observe(lifecycle, reduction.state, now)

      lifecycle = step.lifecycle
      yield* SubscriptionRef.set(state, reduction.state)
      yield* PubSub.publish(changes, { ...reduction, events: step.events, observedAt: now })

      for (const [id, waiting] of pending) {
        const outcome = correlate(waiting.pending, report.value)

        if (outcome !== undefined) yield* settle(id, outcome)
      }
    })

    const startCadence = Effect.suspend(() => {
      const cadence = handshakeDialect.pushall.value

      return cadence === "self-pushing"
        ? Effect.void
        : Effect.asVoid(Effect.forkIn(Effect.forever(Effect.delay(offer(Message.PushAllDue()), cadence.every)), scope))
    })

    const end = (reason: string) => Effect.gen(function* () {
      if (ended !== undefined) return

      ended = reason
      lifecycle = Lifecycle.goOffline(lifecycle)

      for (const id of pending.keys()) yield* settle(id, Ambiguous({ cause: "connection-lost" satisfies AmbiguousCause }))

      for (const request of queued.splice(0)) yield* Deferred.fail(request.done, new SessionClosed({ reason }))

      yield* SubscriptionRef.set(hearing, { since: undefined, ended: true })
      yield* SubscriptionRef.set(status, SessionStatus.EpochEnded({ reason }))
      yield* PubSub.shutdown(changes)
      yield* link.close
    })

    const handle = (message: Message): Effect.Effect<void> => Message.$match(message, {
      Subscribed: () => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis

        yield* SubscriptionRef.set(hearing, { since: now, ended: false })
        yield* SubscriptionRef.set(status, SessionStatus.Handshaking())
        // Rule 5: subscribe, wait, get_version, then pushall.
        yield* Effect.forkIn(Effect.delay(offer(Message.HandshakeDue()), handshakeDialect.settleAfterSubscribe.value), scope)
      }),
      HandshakeDue: () => Effect.gen(function* () {
        yield* internal(Command.GetVersion())
        yield* internal(Command.PushAll())
        ready = true
        yield* SubscriptionRef.set(status, SessionStatus.Ready())
        yield* startCadence

        for (const request of queued.splice(0)) if (!request.cancelled) yield* publish(request)
      }),
      Report: ({ payload }) => onReport(payload),
      Send: ({ request }) => {
        if (request.cancelled) return Effect.void

        if (ended !== undefined) return Deferred.fail(request.done, new SessionClosed({ reason: ended }))

        if (!ready) {
          queued.push(request)

          return Effect.void
        }

        return publish(request)
      },
      PushAllDue: () => (ended === undefined ? internal(Command.PushAll()) : Effect.void),
      TimedOut: ({ id }) => settle(id, Ambiguous({ cause: "timeout" })),
      Ended: ({ reason }) => end(reason)
    })

    yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(mailbox), (message) => Effect.asVoid(handle(message)))), scope)

    // The link fiber: subscribe, then feed every report to the actor. Its end is the epoch's end.
    yield* Effect.forkIn(
      Effect.scoped(Effect.gen(function* () {
        const reports = yield* link.subscribe

        yield* offer(Message.Subscribed())
        yield* Stream.runForEach(reports, (payload) => offer(Message.Report({ payload })))
      })).pipe(
        Effect.exit,
        Effect.flatMap((exit) => offer(Message.Ended({
          reason: Exit.match(exit, { onSuccess: () => "the link closed", onFailure: (cause) => Cause.pretty(cause) })
        })))
      ),
      scope
    )

    yield* Effect.addFinalizer(() => offer(Message.Ended({ reason: "the session's scope closed" })).pipe(
      Effect.andThen(SubscriptionRef.changes(status).pipe(Stream.filter(SessionStatus.$is("EpochEnded")), Stream.runHead))
    ))

    const send = (command: Command, hooks: PublishHooks = noHooks): Effect.Effect<CommandOutcome<unknown>, NotSent | SessionClosed> =>
      Effect.gen(function* () {
        // After the scope closes the actor is gone, so a late send must not wait on it.
        if (ended !== undefined) return yield* new SessionClosed({ reason: ended })

        if (options.access === "observe" && accessOf(command) !== "observe") {
          return yield* new NotSent({ reason: `an observe session cannot send ${command._tag}` })
        }

        const done = yield* Deferred.make<CommandOutcome<unknown>, NotSent | SessionClosed>()
        const request: Request = { command, hooks, done, claimed: false, cancelled: false }

        yield* offer(Message.Send({ request }))

        return yield* Deferred.await(done).pipe(Effect.onInterrupt(() => Effect.sync(() => {
          if (!request.claimed) request.cancelled = true
        })))
      })

    const awaitSilence = (duration: Duration.Input): Effect.Effect<void, SessionClosed> => Effect.gen(function* () {
      const limit = Duration.toMillis(duration)

      while (true) {
        const current = yield* SubscriptionRef.get(hearing)

        if (current.ended) return yield* new SessionClosed({ reason: "the epoch ended" })

        const nextChange = SubscriptionRef.changes(hearing).pipe(Stream.drop(1), Stream.runHead, Effect.asVoid)

        if (current.since === undefined) {
          yield* nextChange
          continue
        }

        const remaining = current.since + limit - (yield* Clock.currentTimeMillis)

        if (remaining <= 0) return

        const woke = yield* Effect.raceFirst(Effect.as(Effect.sleep(remaining), "slept" as const), Effect.as(nextChange, "heard" as const))

        if (woke === "slept" && (yield* SubscriptionRef.get(hearing)).since === current.since) return
      }
    })

    const session: PrinterSession<Access> = {
      access: options.access,
      status: SubscriptionRef.changes(status).pipe(Stream.takeUntil(SessionStatus.$is("EpochEnded"))),
      state: { get: SubscriptionRef.get(state), changes: SubscriptionRef.changes(state) },
      lifecycle: Effect.sync(() => lifecycle),
      changes: Stream.fromPubSub(changes),
      awaitSilence,
      // SAFETY: send checks the access level at runtime as well; the overloads only narrow what compiles.
      send: send as ControlSend,
      close: Effect.andThen(
        offer(Message.Ended({ reason: "the session was closed" })),
        Effect.asVoid(SubscriptionRef.changes(status).pipe(Stream.filter(SessionStatus.$is("EpochEnded")), Stream.runHead))
      )
    }

    // SAFETY: the session was built for options.access, which is X.
    return session as PrinterSession<X>
  })

