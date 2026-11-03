import assert from "node:assert/strict"
import { Schema } from "effect"
import fc from "fast-check"
import { atPath, merge, sourceAtPath } from "../src/wire/merge.ts"
import type { Evidence } from "../src/wire/merge.ts"

const test: (name: string, run: () => void) => void = process.versions.bun ? (await import("node:test")).test : (await import("vitest")).test

const options = {
  numRuns: Number(process.env.WIRE_MERGE_RUNS ?? 50),
  seed: Number(process.env.WIRE_MERGE_SEED ?? 73129)
}

const scalar = fc.oneof(fc.constant(null), fc.boolean(), fc.integer({ min: -3, max: 3 }), fc.constantFrom("toy", "spare", "0", "1"))

const leaf = fc.oneof(scalar, fc.array(scalar, { maxLength: 3 }), fc.dictionary(fc.constantFrom("x", "y"), scalar, { maxKeys: 2 }))

const moduleEntry = fc.oneof(scalar, fc.record({ name: fc.constantFrom("motor", "feeder", "panel"), sw_ver: leaf }), fc.record({ name: fc.constantFrom("motor", "feeder", "panel") }), fc.record({ extra: leaf }))

const ams = fc.oneof(leaf, fc.dictionary(fc.constantFrom("ams_exist_bits", "ams", "tray_now"), leaf, { maxKeys: 3 }), fc.record({ ams_exist_bits: fc.constant("0"), ams: fc.array(leaf, { maxLength: 3 }) }))

const category = fc.dictionary(fc.constantFrom("command", "sequence_id", "payload", "other"), leaf, { maxKeys: 4 })

const report: fc.Arbitrary<Schema.JsonObject> = fc.oneof(
  fc.record({ print: scalar }),
  fc.record({ print: fc.array(leaf, { maxLength: 3 }) }),
  fc.record({ print: category }),
  fc.record({ print: fc.record({ ams }) }),
  fc.record({ info: fc.record({ module: fc.array(moduleEntry, { maxLength: 6 }), command: scalar, sequence_id: scalar }) }),
  fc.record({ info: leaf, future: category })
)

const reports = fc.array(report, { minLength: 1, maxLength: 20 })

const object = Schema.is(Schema.JsonObject)

// The oracle carries time with the value, never with an array index path.
// Flattening this tree from scratch makes module relocation independent of
// merge.ts's forget/stamp/reindex implementation.
type Node = { readonly time: number; readonly value: Schema.Json } | { readonly time: number | undefined; readonly children: ReadonlyMap<string, Node>; readonly array: boolean }

const node = (value: Schema.Json, time: number): Node => Array.isArray(value)
  ? { time, children: new Map(value.map((item, index) => [String(index), node(item, time)])), array: true }
  : object(value) ? { time, children: new Map(Object.entries(value).map(([key, item]) => [key, node(item, time)])), array: false }
    : { time, value }

const json = (entry: Node): Schema.Json => "value" in entry ? entry.value : entry.array ? [...entry.children.values()].map(json) : Object.fromEntries([...entry.children].map(([key, child]) => [key, json(child)]))

const children = (entry: Node | undefined): Map<string, Node> => entry !== undefined && "children" in entry && !entry.array ? new Map(entry.children) : new Map()

const identity = (entry: Node): Schema.Json | undefined => {
  const value = json(entry)

  return object(value) ? value.name : undefined
}

const fold = (previous: ReadonlyMap<string, Node>, incoming: Schema.JsonObject, time: number): ReadonlyMap<string, Node> => {
  const result = new Map(previous)

  for (const [categoryName, body] of Object.entries(incoming)) {
    if (!object(body)) {
      result.set(categoryName, node(body, time))
      continue
    }

    const fields = children(previous.get(categoryName))

    for (const [key, value] of Object.entries(body)) {
      if (key === "command" || key === "sequence_id") continue

      if (categoryName === "info" && key === "module" && Array.isArray(value)) {
        const old = fields.get(key)
        const entries = new Map<Schema.Json | symbol, Node>()

        if (old !== undefined && "children" in old && old.array) {
          for (const entry of old.children.values()) {
            const name = identity(entry)

            if (name !== undefined) entries.set(name, entry)
          }
        }

        for (const valueEntry of value) {
          const entry = node(valueEntry, time)
          const name = identity(entry)

          if (name === undefined) entries.set(Symbol(), entry)
          else entries.set(name, entry)
        }

        fields.set(key, { time, array: true, children: new Map([...entries.values()].map((entry, index) => [String(index), entry])) })
      } else if (categoryName === "print" && key === "ams" && object(value)) {
        const reset = value.ams_exist_bits === "0"
        const units = reset ? new Map<string, Node>() : children(fields.get(key))

        for (const [child, item] of Object.entries(value)) {
          if (reset && child === "ams") continue

          units.set(child, node(item, time))
        }

        // AMS folds stamp reported children, not the structural container.
        fields.set(key, { time: undefined, array: false, children: units })
      } else fields.set(key, node(value, time))
    }

    result.set(categoryName, { time, array: false, children: fields })
  }

  return result
}

const times = (tree: ReadonlyMap<string, Node>): Map<string, number> => {
  const result = new Map<string, number>()

  const visit = (entry: Node, path: string): void => {
    if (entry.time !== undefined) result.set(path, entry.time)

    if ("children" in entry) for (const [key, child] of entry.children) visit(child, `${path}.${key}`)
  }

  // Object category roots are structural; scalar/array bodies are stamped.
  for (const [key, entry] of tree) {
    if ("children" in entry && !entry.array) {
      for (const [child, value] of entry.children) visit(value, `${key}.${child}`)
    } else visit(entry, key)
  }

  return result
}

const sequence = (items: Schema.JsonObject[], check: (actual: Evidence, expected: ReadonlyMap<string, Node>) => void): void => {
  let actual: Evidence = { raw: {}, observedAt: new Map() }
  let expected: ReadonlyMap<string, Node> = new Map()

  items.forEach((incoming, index) => {
    const now = index + 1
    actual = merge(actual, incoming, now)
    expected = fold(expected, incoming, now)

    try {
      check(actual, expected)
    } catch (cause) {
      throw new Error(`After report ${now}: ${JSON.stringify(incoming)}\nSteps: ${JSON.stringify(items.slice(0, now))}`, { cause })
    }
  })
}

test("wire merge: raw follows whole module identity, AMS reset and envelope exclusion", () => {
  fc.assert(fc.property(reports, (items) => sequence(items, (actual, expected) => {
    // Wire evidence is JSON; fast-check may construct null-prototype objects.
    const wireRaw = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(JSON.stringify(actual.raw)))

    assert.deepEqual(wireRaw, Object.fromEntries([...expected].map(([key, entry]) => [key, json(entry)])))
  })), options)
})

test("wire merge: every observedAt path resolves to retained raw evidence", () => {
  fc.assert(fc.property(reports, (items) => sequence(items, (actual) => {
    for (const path of actual.observedAt.keys()) assert.notEqual(atPath(actual.raw, path), undefined, `Dangling observedAt path ${path}`)
  })), options)
})

test("wire merge: timed raw nodes have their last writer time", () => {
  fc.assert(fc.property(reports, (items) => sequence(items, (actual, expected) => {
    for (const [path, time] of times(expected)) {
      assert.equal(actual.observedAt.get(path), time, `Missing or incorrect observedAt at ${path}`)
    }
  })), options)
})

test("wire paths: a scalar ancestor is malformed evidence, not a missing leaf", () => {
  fc.assert(fc.property(scalar, fc.array(fc.constantFrom("x", "y"), { minLength: 1, maxLength: 5 }), (value, suffix) => {
    const raw = { print: { payload: value } }
    const path = `print.payload.${suffix.join(".")}`
    assert.deepEqual(sourceAtPath(raw, path), { path: "print.payload", raw: value })
    assert.equal(atPath(raw, path), undefined)
  }), options)
})
