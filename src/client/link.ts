import { Buffer } from "node:buffer"
import type * as tls from "node:tls"
import { Data, Duration, Effect, Queue, Redacted, Stream } from "effect"
import type { Cause } from "effect"
import type { Scope } from "effect"
import { connect } from "@printhive/mqtt"
import type { MqttError } from "@printhive/mqtt"
import type { Tape } from "../tape/format.ts"

/** The link to the printer failed or ended. Nothing about the printer follows from it. */
export class LinkError extends Data.TaggedError("LinkError")<{ readonly message: string }> {}

/**
 * One connection epoch to a printer, as the session needs it. `publish` succeeds once the bytes are written and
 * fails only when none were, so a failure is `NotSent`.
 */
export interface Link {
  /** Subscribes to the printer's reports and waits for the grant. The stream fails when the link ends. */
  readonly subscribe: Effect.Effect<Stream.Stream<string, LinkError>, LinkError, Scope.Scope>
  readonly publish: (payload: string) => Effect.Effect<void, LinkError>
  readonly close: Effect.Effect<void>
}

export interface MqttLinkOptions {
  readonly host: string
  /** Defaults to 8883. */
  readonly port?: number | undefined
  readonly serial: string
  readonly accessCode: Redacted.Redacted<string>
  /** Passed to `tls.connect`. Bambu printers present a certificate from Bambu's own CA. */
  readonly tls: tls.ConnectionOptions
  /** Defaults to 60 seconds. */
  readonly keepAlive?: Duration.Input | undefined
  /** Defaults to 10 seconds. */
  readonly connectTimeout?: Duration.Input | undefined
}

const linkError = (error: MqttError) => new LinkError({ message: `${error._tag}: ${"message" in error ? error.message : "no detail"}` })

/**
 * An MQTT link on `@printhive/mqtt`: a fresh client with `reconnect: false` and QoS 0 requests, so nothing crosses
 * an epoch and a Start Print can never be delivered late after a reconnect (synthesis.md grafts).
 */
export const mqttLink = (options: MqttLinkOptions): Effect.Effect<Link, LinkError, Scope.Scope> => Effect.gen(function* () {
  const client = yield* connect({
    host: options.host,
    port: options.port ?? 8883,
    tls: options.tls,
    username: "bblp",
    password: Redacted.value(options.accessCode),
    reconnect: false,
    cleanSession: true,
    keepAlive: options.keepAlive ?? "60 seconds",
    connectTimeout: options.connectTimeout ?? "10 seconds"
  }).pipe(Effect.mapError(linkError))

  return {
    subscribe: client.subscribe(`device/${options.serial}/report`).pipe(
      Effect.map((messages) => messages.pipe(
        Stream.map((message) => Buffer.from(message.payload).toString("utf8")),
        Stream.mapError(linkError)
      )),
      Effect.mapError(linkError)
    ),
    publish: (payload) => Effect.mapError(client.publish(`device/${options.serial}/request`, payload), linkError),
    close: client.close({ force: true })
  }
})

/**
 * A link that plays a tape's printer side. Each request the session publishes must equal the tape's next request,
 * byte for byte as JSON; then the reports the printer sent up to its following request arrive. A request that
 * differs ends the link with the difference, so the session's handshake, encoding and correlation are checked
 * against bytes a real printer sent, through production code, with no sockets.
 */
export const tapeLink = (tape: Tape): Effect.Effect<Link> => Effect.gen(function* () {
  const inbox = yield* Queue.unbounded<string, LinkError | Cause.Done>()
  let cursor = 0

  const deliverUntilNextRequest = () => {
    const payloads: string[] = []

    while (cursor < tape.frames.length) {
      const frame = tape.frames[cursor]

      if (frame === undefined || frame.dir === "tx") break

      payloads.push("frame" in frame ? JSON.stringify(frame.frame) : frame.raw)
      cursor += 1
    }

    return payloads
  }

  const end = (message: string) => Queue.fail(inbox, new LinkError({ message }))

  return {
    subscribe: Effect.gen(function* () {
      yield* Queue.offerAll(inbox, deliverUntilNextRequest())

      return Stream.fromQueue(inbox)
    }),
    publish: (payload) => Effect.gen(function* () {
      const expected = tape.frames[cursor]

      if (expected === undefined) return yield* end(`the tape has no request left for ${payload}`)

      const sent = JSON.stringify(JSON.parse(payload))
      const recorded = "frame" in expected ? JSON.stringify(expected.frame) : expected.raw

      if (sent !== recorded) return yield* end(`diverged from the tape at t=${expected.t}: sent ${sent}, the tape sent ${recorded}`)

      cursor += 1
      yield* Queue.offerAll(inbox, deliverUntilNextRequest())
    }),
    close: Effect.asVoid(Queue.end(inbox))
  }
})
