import { Predicate, Schema } from "effect"
import type { ModelResolution } from "../models/resolve.ts"
import { resolveModel } from "../models/resolve.ts"
import { Serial } from "../wire/ids.ts"
import { atPath, merge } from "../wire/merge.ts"
import type { Evidence } from "../wire/merge.ts"
import { decodeReport, isObject } from "../wire/report.ts"
import { fieldRows, fieldTable } from "./fields.ts"
import type { Section, Sections } from "./fields.ts"
import { project, sameContent, sameObservation } from "./project.ts"

const evidenceKey: unique symbol = Symbol("wire evidence")

export interface PrinterState extends Sections {
  readonly serial: Serial
  readonly model: ModelResolution | undefined
  readonly [evidenceKey]: Evidence
}

export type Delta = { readonly [K in Section]?: Sections[K] } & { readonly model?: ModelResolution | undefined }

export interface Reduction {
  readonly state: PrinterState
  readonly delta: Delta
  readonly unclaimed: ReadonlyArray<string>
}

const projectSections = (evidence: Evidence, model: ModelResolution | undefined): Sections => {
  const context = { evidence, model, prefix: "" }

  return {
    execution: project(fieldTable.execution, context),
    progress: project(fieldTable.progress, context),
    temperature: project(fieldTable.temperature, context),
    fans: project(fieldTable.fans, context),
    network: project(fieldTable.network, context),
    job: project(fieldTable.job, context),
    faults: project(fieldTable.faults, context),
    ams: project(fieldTable.ams, context),
    externalSpool: project(fieldTable.externalSpool, context),
    lighting: project(fieldTable.lighting, context),
    hardware: project(fieldTable.hardware, context)
  }
}

export const initialState = (serial: string): PrinterState => {
  const id = Schema.decodeUnknownSync(Serial)(serial)
  const evidence: Evidence = { raw: {}, observedAt: new Map() }
  const model = resolveModel(id, undefined)

  return { ...projectSections(evidence, model), serial: id, model, [evidenceKey]: evidence }
}

const leaves = (value: Schema.Json, prefix: string): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.length === 0 ? [prefix] : value.flatMap((item, index) => leaves(item, `${prefix}.${index}`))

  if (isObject(value)) {
    const entries = Object.entries(value)

    return entries.length === 0 ? (prefix ? [prefix] : []) : entries.flatMap(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key))
  }

  return [prefix]
}

const claimed = (path: string): boolean => {
  if (/^(print|info|system|pushing|camera|xcam)\.(command|sequence_id)$/.test(path)) return true

  if (path === "print.printer_type" || path === "info.printer_type") return true

  return fieldRows.some((row) => {
    const pattern = row.wirePath.split(".")
    const parts = path.split(".")

    return parts.length <= pattern.length && parts.every((part, index) => pattern[index] === "*" || pattern[index] === part)
  })
}

export const reduce = (previous: PrinterState, report: Schema.JsonObject, now: number): Reduction => {
  Schema.decodeUnknownSync(Schema.Finite)(now)
  const decoded = decodeReport(report)
  const evidence = merge(previous[evidenceKey], decoded, now)
  const reportedType = atPath(evidence.raw, "print.printer_type") ?? atPath(evidence.raw, "info.printer_type")
  const resolved = resolveModel(previous.serial, Predicate.isString(reportedType) ? reportedType : undefined)
  const model = previous.model?.id === resolved?.id && previous.model?.via === resolved?.via ? previous.model : resolved
  const delta: { -readonly [K in keyof Delta]?: Delta[K] } = {}

  const section = <K extends Section>(key: K): Sections[K] => {
    const touched = model !== previous.model || Object.values(fieldTable[key]).some((node) =>
      atPath(previous[evidenceKey].raw, node.path) !== atPath(evidence.raw, node.path) ||
      previous[evidenceKey].observedAt.get(node.path) !== evidence.observedAt.get(node.path))

    if (!touched) return previous[key]

    // SAFETY: key selects the same section in both the field table and Sections.
    const projected = project(fieldTable[key], { evidence, model, prefix: "" }) as Sections[K]

    if (sameContent(previous[key], projected)) return sameObservation(previous[key], projected) ? previous[key] : projected

    delta[key] = projected

    return projected
  }

  if (model !== previous.model) delta.model = model

  const state: PrinterState = {
    execution: section("execution"),
    progress: section("progress"),
    temperature: section("temperature"),
    fans: section("fans"),
    network: section("network"),
    job: section("job"),
    faults: section("faults"),
    ams: section("ams"),
    externalSpool: section("externalSpool"),
    lighting: section("lighting"),
    hardware: section("hardware"),
    serial: previous.serial,
    model,
    [evidenceKey]: evidence
  }

  return { state, delta, unclaimed: leaves(decoded, "").filter((path) => !claimed(path)) }
}
