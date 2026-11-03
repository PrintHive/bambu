import { Schema } from "effect"

// Leaves are decoded separately so malformed telemetry cannot reject its siblings.
export const Category = Schema.StructWithRest(Schema.Struct({
  command: Schema.optionalKey(Schema.Json),
  sequence_id: Schema.optionalKey(Schema.Json)
}), [Schema.Record(Schema.String, Schema.Json)])

export const Envelope = Schema.JsonObject

export const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject => value !== undefined && Schema.is(Schema.JsonObject)(value)

const decodeEnvelope = Schema.decodeUnknownSync(Envelope)
const decodeCategory = Schema.decodeUnknownSync(Category)

// Validate category objects independently; retain malformed bodies as evidence.
export const decodeReport = (report: Schema.Json): Schema.JsonObject => Object.fromEntries(
  Object.entries(decodeEnvelope(report)).map(([category, body]) => [category, isObject(body) ? decodeCategory(body) : body])
)
