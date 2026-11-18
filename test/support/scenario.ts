// TestClock scenarios over real loopback sockets. Every timer in the client, the emulator and @printhive/mqtt runs
// on Effect's Clock, so no test sleeps for protocol time. Socket I/O still takes real time, so `settle` yields a few
// real milliseconds for bytes in flight, and `advance` moves the clock in steps with I/O between them: a single jump
// past a keep-alive period would fire the PINGRESP deadline before the PINGRESP could arrive.
import { readFileSync } from "node:fs"
import { Duration, Effect, Fiber, Layer, Logger, Option } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"

export const tls = {
  key: readFileSync(new URL("../fixtures/tls/key.pem", import.meta.url)),
  cert: readFileSync(new URL("../fixtures/tls/cert.pem", import.meta.url))
}

export const clientTls = { rejectUnauthorized: false }

/** Lets bytes already written reach the other side. Takes real time, not clock time. */
export const settle = TestClock.withLive(Effect.sleep("10 millis"))

/** Moves the test clock forward in steps, letting socket I/O land after each one. */
export const advance = (duration: Duration.Input, step: Duration.Input = "1 second") => Effect.gen(function* () {
  let left = Duration.toMillis(duration)
  const size = Duration.toMillis(step)

  while (left > 0) {
    const next = Math.min(size, left)

    yield* TestClock.adjust(next)
    yield* settle
    left -= next
  }
})

/** Waits for an effect that depends on socket I/O, failing the test after `limit` of real time. */
export const within = <A, E, R>(effect: Effect.Effect<A, E, R>, limit: Duration.Input = "5 seconds") => Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(effect)
  const result = yield* TestClock.withLive(Effect.timeoutOption(Fiber.join(fiber), limit))

  if (Option.isNone(result)) return yield* Effect.die(new Error(`timed out after ${Duration.format(Duration.fromInputUnsafe(limit))} of real time`))

  return result.value
})

/** True if the fiber has not completed once bytes in flight have landed. */
export const stillPending = <A, E>(fiber: Fiber.Fiber<A, E>) => Effect.map(settle, () => fiber.pollUnsafe() === undefined)

const quiet = Logger.layer([])

/** Runs a scoped scenario under TestClock. */
export const scenario = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestClock.layer(), quiet))))
