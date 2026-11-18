import { Data } from "effect"
import type { Schema } from "effect"

/**
 * What became of a command whose bytes left. `Acknowledged` and `Rejected` carry the printer's reply. `Ambiguous`
 * means the bytes were written and no reply settled it: the printer may or may not have acted, so never resend
 * blindly. A command that was never written fails with `NotSent` instead and has no outcome.
 */
export type CommandOutcome<A> = Data.TaggedEnum<{
  Acknowledged: { readonly reply: A }
  Rejected: { readonly reason: string; readonly report: Schema.JsonObject }
  Ambiguous: { readonly cause: AmbiguousCause }
}>

/**
 * - `timeout`: no matching reply within the dialect's command timeout.
 * - `connection-lost`: the epoch ended after the write.
 * - `publish-hook-failed`: the bytes were written and `onPublished` then failed.
 */
export type AmbiguousCause = "timeout" | "connection-lost" | "publish-hook-failed"

interface OutcomeDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: CommandOutcome<this["A"]>
}

const constructors = Data.taggedEnum<OutcomeDefinition>()

export const { Acknowledged, Rejected, Ambiguous } = constructors

export const match = constructors.$match

/** No byte of the command was written, so a retry is safe. */
export class NotSent extends Data.TaggedError("NotSent")<{ readonly reason: string }> {}

/** The session had already ended when the command arrived, so nothing was written and a retry on a new one is safe. */
export class SessionClosed extends Data.TaggedError("SessionClosed")<{ readonly reason: string }> {}

/** The caller's `beforePublish` refused the publish. The session turns it into `NotSent`. */
export class Refused extends Data.TaggedError("Refused")<{ readonly reason: string }> {}
