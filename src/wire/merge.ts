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

    // Forget times only for evidence the old body held. A dotted category name
    // such as "print.mc_percent" shares its path with a real reading, whose
    // time must survive.
    if (oldBody !== undefined && !isObject(oldBody)) {
      const rest = { ...raw }
      delete rest[category]

      for (const key of [...observedAt.keys()]) {
        if ((key === category || key.startsWith(`${category}.`)) && atPath(rest, key) === undefined) observedAt.delete(key)
      }
    }

    for (const [key, value] of Object.entries(body)) {
      if (envelopeKeys.has(key)) continue

      const path = `${category}.${key}`
      const old = next[key]

      if (category === "print" && key === "ams" && isObject(value)) {
        if (!isObject(old)) forget(path, observedAt)
        const reset = value.ams_exist_bits === "0"
        const base = !reset && isObject(old) ? old : {}
        const merged = { ...base, ...value }

        if (reset) {
          delete merged.ams
          forget(path, observedAt)
        }

        next[key] = merged

        for (const [child, item] of Object.entries(value)) {
          if (reset && child === "ams") continue

          forget(`${path}.${child}`, observedAt)
          stamp(item, `${path}.${child}`, now, observedAt)
        }
      } else if (category === "info" && key === "module" && Array.isArray(value)) {
        // Each get_version entry describes one whole module, so a match by name
        // replaces it, including fields the newer entry omits. Merging fields
        // could pair a swapped AMS unit's old `sn` with the new unit's `sw_ver`.
        // Omitted named modules are kept; nameless modules have no identity,
        // so each reply replaces that set. Reindex retained observation paths.
        const modules: Schema.Json[] = []
        forget(path, observedAt)

        if (Array.isArray(old)) {
          old.forEach((item, index) => {
            if (!isObject(item) || item.name === undefined) return

            const from = `${path}.${index}`
            const to = `${path}.${modules.length}`
            modules.push(item)

            for (const [key, time] of previous.observedAt) {
              if (key === from || key.startsWith(`${from}.`)) observedAt.set(`${to}${key.slice(from.length)}`, time)
            }
          })
        }

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

// A non-container ancestor is evidence of a malformed path, not a missing leaf.
export const sourceAtPath = (raw: Schema.Json, path: string): { readonly path: string; readonly raw: Schema.Json } | undefined => {
  let value: Schema.Json | undefined = raw
  const parts: string[] = []

  for (const key of path.split(".")) {
    if (value === undefined) return undefined

    if (Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(key)) value = value[Number(key)]
    else if (isObject(value)) value = value[key]
    else return { path: parts.join("."), raw: value }

    parts.push(key)
  }

  return value === undefined ? undefined : { path, raw: value }
}

export const atPath = (raw: Schema.Json, path: string): Schema.Json | undefined => {
  const source = sourceAtPath(raw, path)

  return source?.path === path ? source.raw : undefined
}
