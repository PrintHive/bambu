// Scores emulator traffic against a captured tape on the five fidelity dimensions of hive's mock printer. Tapes are
// the truth: each dimension reads its expectation from the tape and measures the emulator against it.
import { Predicate } from "effect"
import type { Schema } from "effect"
import type { Tape, TapeFrame } from "../tape/format.ts"
import { isObject } from "../wire/report.ts"

export interface Dimension {
  /** From 0 to 1. */
  readonly score: number
  /** How many tape samples the score rests on. A score from 0 samples is vacuous. */
  readonly samples: number
  readonly detail: string
}

export interface Fidelity {
  /** Report bodies carry the same keys, per reply kind. */
  readonly keySet: Dimension
  /** `gcode_state` changes arrive in the same order. */
  readonly sequences: Dimension
  /** Each acknowledged request gets the same envelope: command, sequence id, result and reason. */
  readonly ackEnvelopes: Dimension
  /** Each request the tape shows rejected is rejected. */
  readonly rejects: Dimension
  /** Partial reports arrive at the same interval. */
  readonly cadence: Dimension
}

type Framed = Extract<TapeFrame, { readonly frame: Schema.JsonObject }>

const framed = (frames: ReadonlyArray<TapeFrame>, dir: "rx" | "tx"): ReadonlyArray<Framed> =>
  frames.flatMap((frame) => (frame.dir === dir && "frame" in frame ? [frame] : []))

const bodyOf = (frame: Framed): readonly [string, Schema.JsonObject] | undefined => {
  const entry = Object.entries(frame.frame).find(([, value]) => isObject(value))

  return entry === undefined || !isObject(entry[1]) ? undefined : [entry[0], entry[1]]
}

/** `print.push_status/full`, `print.push_status/partial`, `info.get_version`, `print.pause`, and so on. */
const kindOf = (frame: Framed): string | undefined => {
  const body = bodyOf(frame)

  if (body === undefined || !Predicate.isString(body[1].command)) return undefined

  const [category, { command, msg }] = body

  return command === "push_status" ? `${category}.push_status/${msg === 0 ? "full" : "partial"}` : `${category}.${command}`
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  const union = new Set([...a, ...b])

  return union.size === 0 ? 1 : [...a].filter((key) => b.has(key)).length / union.size
}

const keysByKind = (frames: ReadonlyArray<Framed>): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>()

  for (const frame of frames) {
    const kind = kindOf(frame)
    const body = bodyOf(frame)

    if (kind === undefined || body === undefined) continue

    const keys = out.get(kind) ?? new Set()

    for (const key of Object.keys(body[1])) keys.add(key)

    out.set(kind, keys)
  }

  return out
}

const mean = (values: ReadonlyArray<number>): number => (values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length)

const keySet = (tape: ReadonlyArray<Framed>, emulated: ReadonlyArray<Framed>): Dimension => {
  const expected = keysByKind(tape)
  const actual = keysByKind(emulated)
  const scores = [...expected].map(([kind, keys]) => [kind, jaccard(keys, actual.get(kind) ?? new Set())] as const)

  return {
    score: mean(scores.map(([, score]) => score)),
    samples: scores.length,
    detail: scores.map(([kind, score]) => `${kind} ${score.toFixed(2)}`).join(", ")
  }
}

const states = (frames: ReadonlyArray<Framed>): ReadonlyArray<string> => frames.flatMap((frame) => {
  const state = isObject(frame.frame.print) ? frame.frame.print.gcode_state : undefined

  return Predicate.isString(state) ? [state] : []
}).filter((state, index, all) => index === 0 || all[index - 1] !== state)

const sequences = (tape: ReadonlyArray<Framed>, emulated: ReadonlyArray<Framed>): Dimension => {
  const expected = states(tape)
  const actual = states(emulated)
  const same = expected.length === actual.length && expected.every((state, index) => actual[index] === state)

  return { score: same ? 1 : 0, samples: expected.length, detail: `tape ${expected.join(" > ")}; emulator ${actual.join(" > ")}` }
}

interface Exchange {
  readonly request: Framed
  readonly reply: Schema.JsonObject | undefined
}

/** Pairs each request with the reply that echoes its command and sequence id. */
const exchanges = (frames: ReadonlyArray<TapeFrame>): ReadonlyArray<Exchange> => {
  const replies = framed(frames, "rx")

  return framed(frames, "tx").flatMap((request) => {
    const body = bodyOf(request)

    if (body === undefined) return []

    const [category, { command }] = body
    const reply = replies.find((frame) => frame.t >= request.t && isObject(frame.frame[category]) && frame.frame[category].command === command)

    return [{ request, reply: reply === undefined ? undefined : bodyOf(reply)?.[1] }]
  })
}

const envelope = (exchange: Exchange): string => {
  const request = bodyOf(exchange.request)?.[1]
  const reply = exchange.reply

  if (reply === undefined || request === undefined) return "no reply"

  const echoed = reply.sequence_id === request.sequence_id ? "echo" : `sequence ${String(reply.sequence_id)}`

  return `${String(reply.command)} ${echoed} result=${String(reply.result)} reason=${String(reply.reason)}`
}

const ackEnvelopes = (tape: ReadonlyArray<TapeFrame>, emulated: ReadonlyArray<TapeFrame>): Dimension => {
  const expected = exchanges(tape).filter((exchange) => exchange.reply !== undefined)
  const actual = exchanges(emulated)

  const results = expected.map((exchange) => {
    const command = bodyOf(exchange.request)?.[1].command
    const match = actual.find((other) => bodyOf(other.request)?.[1].command === command)

    return [String(command), match !== undefined && envelope(match) === envelope(exchange)] as const
  })

  return {
    score: mean(results.map(([, ok]) => (ok ? 1 : 0))),
    samples: results.length,
    detail: results.map(([command, ok]) => `${command} ${ok ? "same" : "differs"}`).join(", ")
  }
}

const rejected = (exchange: Exchange): boolean => {
  const result = exchange.reply?.result

  return Predicate.isString(result) && result.toLowerCase() !== "success"
}

const rejects = (tape: ReadonlyArray<TapeFrame>, emulated: ReadonlyArray<TapeFrame>): Dimension => {
  const expected = exchanges(tape).filter(rejected)
  const actual = exchanges(emulated)

  const results = expected.map((exchange) =>
    actual.some((other) => bodyOf(other.request)?.[1].command === bodyOf(exchange.request)?.[1].command && rejected(other)))

  return { score: mean(results.map((ok) => (ok ? 1 : 0))), samples: results.length, detail: `${results.filter(Boolean).length} of ${results.length} rejected` }
}

const median = (values: ReadonlyArray<number>): number | undefined => {
  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.floor(sorted.length / 2)]
}

const intervals = (frames: ReadonlyArray<Framed>): ReadonlyArray<number> => {
  const times = frames.flatMap((frame) => (kindOf(frame)?.endsWith("/partial") ? [frame.t] : []))

  return times.slice(1).map((time, index) => time - (times[index] ?? time))
}

const cadence = (tape: ReadonlyArray<Framed>, emulated: ReadonlyArray<Framed>): Dimension => {
  const expected = intervals(tape)
  const tapeMedian = median(expected)
  const emulatedMedian = median(intervals(emulated))

  if (tapeMedian === undefined || emulatedMedian === undefined) {
    return { score: 0, samples: expected.length, detail: "not enough partial reports to compare" }
  }

  return {
    score: Math.max(0, 1 - Math.abs(tapeMedian - emulatedMedian) / tapeMedian),
    samples: expected.length,
    detail: `median interval: tape ${tapeMedian.toFixed(3)} s, emulator ${emulatedMedian.toFixed(3)} s`
  }
}

/** Scores `emulated`, the frames an emulator sent and received while replaying `tape`'s requests. */
export const score = (tape: Tape, emulated: ReadonlyArray<TapeFrame>): Fidelity => {
  const tapeReports = framed(tape.frames, "rx")
  const emulatedReports = framed(emulated, "rx")

  return {
    keySet: keySet(tapeReports, emulatedReports),
    sequences: sequences(tapeReports, emulatedReports),
    ackEnvelopes: ackEnvelopes(tape.frames, emulated),
    rejects: rejects(tape.frames, emulated),
    cadence: cadence(tapeReports, emulatedReports)
  }
}
