import { Schema } from "effect"

export const Serial = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{15}$/)).pipe(Schema.brand("Serial"))

export type Serial = typeof Serial.Type

export const SequenceId = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(Schema.brand("SequenceId"))

export type SequenceId = typeof SequenceId.Type

const AccessCodeValue = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{8}$/)).pipe(Schema.brand("AccessCode"))
export const AccessCode = Schema.RedactedFromValue(AccessCodeValue)

export type AccessCode = typeof AccessCode.Type
