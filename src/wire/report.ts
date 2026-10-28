import { Schema } from "effect"

// Leaves are decoded separately so malformed telemetry cannot reject its siblings.
export const Category = Schema.StructWithRest(Schema.Struct({
  command: Schema.optionalKey(Schema.Json),
  sequence_id: Schema.optionalKey(Schema.Json)
}), [Schema.Record(Schema.String, Schema.Json)])

export const Envelope = Schema.StructWithRest(Schema.Struct({
  print: Schema.optionalKey(Category),
  info: Schema.optionalKey(Category),
  system: Schema.optionalKey(Category),
  pushing: Schema.optionalKey(Category),
  camera: Schema.optionalKey(Category),
  xcam: Schema.optionalKey(Category)
}), [Schema.Record(Schema.String, Schema.Json)])

export const decodeReport = Schema.decodeUnknownSync(Envelope)
export const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject => value !== undefined && Schema.is(Schema.JsonObject)(value)
