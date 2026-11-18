// The session over a tape's printer side, with no sockets and no emulator: the handshake, encoding and correlation
// are checked against bytes a real P1S sent (synthesis.md, the Tape transport graft).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Effect, Option, Predicate, Stream } from "effect"
import { replay, SessionStatus } from "../src/client/index.ts"
import type { PrinterSession } from "../src/client/index.ts"
import { Reading } from "../src/index.ts"
import { Command, Fact } from "../src/protocol/index.ts"
import { parseTape } from "../src/tape/format.ts"
import type { Tape } from "../src/tape/format.ts"
import { test, todo } from "./support/harness.ts"
import { advance, scenario, settle, within } from "./support/scenario.ts"

const tape = parseTape(readFileSync(new URL("./fixtures/tapes/p1s-01.09.00.00/idle-2026-09-18.jsonl", import.meta.url), "utf8"))

const statuses = (session: PrinterSession<"control">) => Effect.gen(function* () {
  const seen: string[] = []

  yield* Effect.forkScoped(Stream.runForEach(session.status, (status) => Effect.sync(() => seen.push(status._tag))))

  return seen
})

const present = <A>(reading: Reading.Reading<A>): A | undefined => (Predicate.isTagged(reading, "Present") ? reading.value : undefined)

test("rule 5: the session's handshake and commands match the P1S tape byte for byte, and every reply correlates", () => scenario(Effect.gen(function* () {
  const session = yield* replay(tape, { serial: "01PMOCK00000001", access: "control" })
  const seen = yield* statuses(session)

  yield* settle
  yield* advance("2 seconds")

  const pause = yield* session.send(Command.Pause())
  const resume = yield* session.send(Command.Resume())

  assert.ok(Predicate.isTagged(pause, "Acknowledged"))
  assert.equal(pause.reply.reason, "success")
  assert.ok(Predicate.isTagged(resume, "Acknowledged"))
  assert.deepEqual(seen, ["Subscribing", "Handshaking", "Ready"])

  const state = yield* session.state.get

  assert.equal(state.model?.id, "P1S")
  assert.equal(present(state.execution.gcodeState), "FINISH")
  assert.equal(present(state.temperature.bed), 25.96875)
})))

test("pushall on the P1S tape settles on the full report, not on a partial one or a sequence echo", () => scenario(Effect.gen(function* () {
  // The tape's handshake, then a second pushall answered by the tape's own reports: a partial one first, then the
  // full one. The reports are the printer's bytes; only their order around the extra request is arranged.
  const [getVersion, version, pushall, full, partial] = tape.frames

  assert.ok(getVersion && version && pushall && full && partial && "frame" in full && "frame" in partial)

  const arranged: Tape = {
    header: tape.header,
    frames: [getVersion, version, pushall, full, { t: 30, dir: "tx", topic: pushall.topic, frame: { pushing: { sequence_id: "2", command: "pushall" } } }, partial, full]
  }

  const session = yield* replay(arranged, { serial: "01PMOCK00000001", access: "observe" })

  yield* settle
  yield* advance("2 seconds")

  const outcome = yield* session.send(Command.PushAll())

  assert.ok(Predicate.isTagged(outcome, "Acknowledged"))
  assert.deepEqual(outcome.reply.report, full.frame)
  assert.ok(Fact.isVerified(outcome.reply.rule))
})))

test("a request that differs from the tape ends the epoch and says where", () => scenario(Effect.gen(function* () {
  const session = yield* replay(tape, { serial: "01PMOCK00000001", access: "control" })

  yield* settle
  yield* advance("2 seconds")

  // The tape's third request is a pause; a resume diverges.
  const outcome = yield* session.send(Command.Resume())

  assert.ok(Predicate.isTagged(outcome, "Ambiguous"))
  assert.equal(outcome.cause, "connection-lost")

  const ended = yield* within(session.status.pipe(Stream.filter(SessionStatus.$is("EpochEnded")), Stream.runHead))

  assert.ok(Option.isSome(ended))
  assert.match(ended.value.reason, /diverged from the tape at t=14\.144/)
})))

todo("rule 7: FTPS needs TLS session reuse on the data channel, secureOptions.host on Node 24.17 or later, and per-model timeouts (phase 4)")
