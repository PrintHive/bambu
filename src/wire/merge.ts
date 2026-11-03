import type { Schema } from "effect"
import { isObject } from "./report.ts"

export interface Evidence {
  readonly raw: Schema.JsonObject
  readonly observedAt: ReadonlyMap<string, number>
}

const stamp = (value: Schema.Json, path: string, now: number, times: Map<string, number>): void => {
  times.set(path, now)

  if (Array.isArray(value)) value.forEach((item, index) => stamp(item, `${path}.${index}`, now, times))
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) stamp(item, `${path}.${key}`, now, times)
  }
}

const forget = (path: string, times: Map<string, number>): void => {
  for (const key of times.keys()) {
    if (key === path || key.startsWith(`${path}.`)) times.delete(key)
  }
}

const envelopeKeys = new Set(["command", "sequence_id"])

export const merge = (previous: Evidence, report: Schema.JsonObject, now: number): Evidence => {
  const raw = { ...previous.raw }
  const observedAt = new Map(previous.observedAt)

  for (const [category, body] of Object.entries(report)) {
    if (!isObject(body)) {
      raw[category] = body
      forget(category, observedAt)
      stamp(body, category, now, observedAt)
      continue
    }

    const oldBody = previous.raw[category]
    const next = isObject(oldBody) ? { ...oldBody } : {}

    for (const [key, value] of Object.entries(body)) {
      if (envelopeKeys.has(key)) continue

      const path = `${category}.${key}`
      const old = next[key]

      if (category === "print" && key === "ams" && isObject(value)) {
        const reset = value.ams_exist_bits === "0"
        const base = !reset && isObject(old) ? old : {}
        next[key] = { ...base, ...value }

        if (reset) forget(path, observedAt)

        for (const [child, item] of Object.entries(value)) {
          forget(`${path}.${child}`, observedAt)
          stamp(item, `${path}.${child}`, now, observedAt)
        }
      } else if (category === "info" && key === "module" && Array.isArray(value)) {
        // Each get_version entry describes one whole module, so a match by name
        // replaces it, including fields the newer entry omits. Merging fields
        // could pair a swapped AMS unit's old `sn` with the new unit's `sw_ver`.
        // Modules missing from a reply are kept: a reply need not list them all.
        const modules = Array.isArray(old) ? [...old] : []

        for (const item of value) {
          const index = isObject(item) && item.name !== undefined
            ? modules.findIndex((candidate) => isObject(candidate) && candidate.name === item.name) : -1

          const target = index === -1 ? modules.length : index
          modules[target] = item
          forget(`${path}.${target}`, observedAt)
          stamp(item, `${path}.${target}`, now, observedAt)
        }

        observedAt.set(path, now)
        next[key] = modules
      } else {
        next[key] = value
        forget(path, observedAt)
        stamp(value, path, now, observedAt)
      }
    }

    raw[category] = next
  }

  return { raw, observedAt }
}

export const atPath = (raw: Schema.Json, path: string): Schema.Json | undefined => {
  let value: Schema.Json | undefined = raw

  for (const key of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(key)]
    else value = isObject(value) ? value[key] : undefined
  }

  return value
}
