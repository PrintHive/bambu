import { Effect } from "effect"
import type { Scope } from "effect"
import type { Access } from "../protocol/commands.ts"
import type { Tape } from "../tape/format.ts"
import { mqttLink, tapeLink } from "./link.ts"
import type { LinkError, MqttLinkOptions } from "./link.ts"
import { fromLink } from "./session.ts"
import type { PrinterSession, SessionOptions } from "./session.ts"

export interface OpenOptions<X extends Access> extends SessionOptions<X>, Omit<MqttLinkOptions, "serial"> {}

/**
 * Opens one connection epoch to a printer over MQTT. It fails with `LinkError` if the printer refuses or cannot be
 * reached; the session's `status` reports everything after that. Closing the scope ends the epoch.
 */
export const open = <X extends Access>(options: OpenOptions<X>): Effect.Effect<PrinterSession<X>, LinkError, Scope.Scope> =>
  Effect.flatMap(mqttLink(options), (link) => fromLink(link, options))

/**
 * Runs a session against a tape's printer side, with no sockets. Each request the session sends must match the
 * tape's next request; the tape's reports then arrive. A request that differs ends the epoch, and `status` says how.
 */
export const replay = <X extends Access>(tape: Tape, options: SessionOptions<X>): Effect.Effect<PrinterSession<X>, never, Scope.Scope> =>
  Effect.flatMap(tapeLink(tape), (link) => fromLink(link, options))

export { fromLink, SessionStatus } from "./session.ts"

export type { ControlSend, Observable, ObserveSend, PrinterSession, PublishHooks, SessionOptions, StateChange } from "./session.ts"

export { LinkError, mqttLink, tapeLink } from "./link.ts"

export type { Link, MqttLinkOptions } from "./link.ts"
