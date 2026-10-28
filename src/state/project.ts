import { Predicate, Result, Schema } from "effect"
import type { ModelResolution } from "../models/resolve.ts"
import { atPath } from "../wire/merge.ts"
import type { Evidence } from "../wire/merge.ts"
import { isObject } from "../wire/report.ts"
import type { Collection, FieldGroup, Projection } from "./fields.ts"
import * as Reading from "./reading.ts"

export interface Cells {
  readonly [key: string]: Reading.Reading<Schema.Json | ReadonlyMap<string, Cells>>
}

export interface Context {
  readonly evidence: Evidence
  readonly model: ModelResolution | undefined
  readonly prefix: string
}

const observationTime = (evidence: Evidence, path: string): number => {
  const time = evidence.observedAt.get(path)

  if (time === undefined) throw new Error(`Missing observation time for ${path}`)

  return time
}

const projectCollection = (node: Collection, context: Context): Reading.Reading<ReadonlyMap<string, Cells>> => {
  const path = `${context.prefix}${node.path}`
  const raw = atPath(context.evidence.raw, path)

  if (raw === undefined) {
    return path === "print.ams.ams" && atPath(context.evidence.raw, "print.ams.ams_exist_bits") === "0"
      ? Reading.Absent() : Reading.Unknown()
  }

  if (!Array.isArray(raw)) return Reading.Invalid({ raw, issue: "Expected an array" })

  const value = new Map<string, Cells>()

  raw.forEach((item, index) => {
    const identity = isObject(item) ? item[node.identity] : undefined
    const key = Predicate.isString(identity) || Predicate.isNumber(identity) ? String(identity) : `#${index}`
    value.set(key, project(node.fields, { ...context, prefix: `${path}.${index}.` }))
  })

  return Reading.Present({ value, observedAt: observationTime(context.evidence, path) })
}

export const project = <T extends FieldGroup>(group: T, context: Context): Projection<T> => {
  const out: { -readonly [K in keyof Cells]: Cells[K] } = {}

  for (const [key, node] of Object.entries(group)) {
    if (node.kind === "collection") {
      out[key] = projectCollection(node, context)
      continue
    }

    const path = `${context.prefix}${node.path}`
    const source = node.unsupported(context.model)
    const raw = atPath(context.evidence.raw, path)

    if (source !== undefined) out[key] = Reading.Unsupported({ source })
    else if (raw === undefined) out[key] = Reading.Unknown()
    else {
      out[key] = Result.match(Schema.decodeUnknownResult(node.schema)(raw), {
        onSuccess: (value) => Reading.Present({ value, observedAt: observationTime(context.evidence, path) }),
        onFailure: (issue) => Reading.Invalid({ raw, issue: issue.message })
      })
    }
  }

  // SAFETY: every key of group is visited and its descriptor determines the Reading value.
  return out as Projection<T>
}

type Cell = Cells[string]

const sameReading = (before: Cell, after: Cell, includeTime: boolean): boolean => Reading.match(before, {
  Present: (prior) => Predicate.isTagged(after, "Present") &&
    (!includeTime || prior.observedAt === after.observedAt) && sameValue(prior.value, after.value, includeTime),
  Absent: () => Predicate.isTagged(after, "Absent"),
  Unknown: () => Predicate.isTagged(after, "Unknown"),
  Unsupported: ({ source }) => Predicate.isTagged(after, "Unsupported") && JSON.stringify(source) === JSON.stringify(after.source),
  Invalid: ({ raw, issue }) => Predicate.isTagged(after, "Invalid") && issue === after.issue && JSON.stringify(raw) === JSON.stringify(after.raw)
})

const sameValue = (before: Schema.Json | ReadonlyMap<string, Cells>, after: Schema.Json | ReadonlyMap<string, Cells>, includeTime: boolean): boolean => {
  if (before instanceof Map && after instanceof Map) {
    if (before.size !== after.size) return false

    for (const [key, value] of before) {
      const next = after.get(key)

      if (next === undefined || !sameCells(value, next, includeTime)) return false
    }

    return true
  }

  return JSON.stringify(before) === JSON.stringify(after)
}

const sameCells = (before: Cells, after: Cells, includeTime: boolean): boolean => Object.entries(before).every(([key, value]) => {
  const next = after[key]

  return next !== undefined && sameReading(value, next, includeTime)
})

export const sameObservation = (before: Cells, after: Cells): boolean => sameCells(before, after, true)

export const sameContent = (before: Cells, after: Cells): boolean => sameCells(before, after, false)
