import { Schema } from "effect"

/** The first line of a tape: what was captured, from which firmware, and when. */
export const TapeHeader = Schema.Struct({
  header: Schema.Literal(true),
  family: Schema.Literal("bambu"),
  model: Schema.String,
  firmware: Schema.String,
  capturedAt: Schema.String
})

export type TapeHeader = typeof TapeHeader.Type

const FrameFields = {
  t: Schema.Finite,
  dir: Schema.Literals(["rx", "tx"]),
  topic: Schema.String
}

/**
 * One MQTT message: `rx` came from the printer, `tx` was sent to it. `t` is seconds from the start of the
 * capture. A payload that was not a JSON object is kept as `raw` text instead of `frame`.
 */
export const TapeFrame = Schema.Union([
  Schema.Struct({ ...FrameFields, frame: Schema.JsonObject }),
  Schema.Struct({ ...FrameFields, raw: Schema.String })
])

export type TapeFrame = typeof TapeFrame.Type

export interface Tape {
  readonly header: TapeHeader
  readonly frames: ReadonlyArray<TapeFrame>
}

const decodeHeader = Schema.decodeSync(Schema.fromJsonString(TapeHeader))
const decodeFrame = Schema.decodeSync(Schema.fromJsonString(TapeFrame))

/** Parses a JSON Lines tape. Throws on a malformed line, naming its line number. */
export const parseTape = (text: string): Tape => {
  const lines = text.split("\n").flatMap((line, index) => (line.trim() === "" ? [] : [{ line, number: index + 1 }]))
  const [first, ...rest] = lines

  if (first === undefined) throw new Error("A tape needs a header line")

  const parse = <A>(entry: { line: string; number: number }, decode: (line: string) => A): A => {
    try {
      return decode(entry.line)
    } catch (cause) {
      throw new Error(`Tape line ${entry.number} is invalid`, { cause })
    }
  }

  return { header: parse(first, decodeHeader), frames: rest.map((entry) => parse(entry, decodeFrame)) }
}

/** Serializes a tape as JSON Lines, header first. */
export const formatTape = (tape: Tape): string =>
  [tape.header, ...tape.frames].map((line) => JSON.stringify(line)).join("\n") + "\n"
