import { Data } from "effect"
import type { Schema } from "effect"
import type { Source } from "@printhive/bambu-models"

export interface UnsupportedSource {
  readonly model: string
  readonly fact: string
  readonly source: Source
  readonly ref: string
}

export type Reading<A> = Data.TaggedEnum<{
  Present: { readonly value: A; readonly observedAt: number }
  Absent: { readonly observedAt: number }
  Unknown: {}
  Unsupported: { readonly source: UnsupportedSource }
  Invalid: { readonly raw: Schema.Json; readonly issue: string; readonly observedAt: number }
}>

interface ReadingDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Reading<this["A"]>
}

const constructors = Data.taggedEnum<ReadingDefinition>()
export const { Present, Absent, Unknown, Unsupported, Invalid } = constructors
export const match = constructors.$match
