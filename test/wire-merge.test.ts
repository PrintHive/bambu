import assert from "node:assert/strict"
import { initialState, reduce, Reading } from "../src/index.ts"
import { atPath, merge } from "../src/wire/merge.ts"

const test: (name: string, run: () => void) => void = process.versions.bun ? (await import("node:test")).test : (await import("vitest")).test

test("category array replaced by an object forgets times for removed evidence", () => {
  const first = merge({ raw: {}, observedAt: new Map() }, { print: [[]] }, 1)
  const next = merge(first, { print: { ams: { ams_exist_bits: "0", ams: [] } } }, 2)

  assert.deepEqual(next.raw, { print: { ams: { ams_exist_bits: "0" } } })
  assert.deepEqual([...next.observedAt], [["print.ams.ams_exist_bits", 2]])

  for (const path of next.observedAt.keys()) assert.notEqual(atPath(next.raw, path), undefined, path)

  assert.equal(first.observedAt.get("print.0"), 1)
})

test("AMS array replaced by an object forgets times for removed evidence", () => {
  const first = merge({ raw: {}, observedAt: new Map() }, { print: { ams: [0] } }, 1)
  const next = merge(first, { print: { ams: {} } }, 2)

  assert.deepEqual(next.raw, { print: { ams: {} } })
  assert.deepEqual([...next.observedAt], [])

  for (const path of next.observedAt.keys()) assert.notEqual(atPath(next.raw, path), undefined, path)

  assert.equal(first.observedAt.get("print.ams.0"), 1)
})

test("a new dotted category keeps the time of the reading that shares its path", () => {
  const first = reduce(initialState("000FAKE00000001"), { print: { mc_percent: 40 } }, 1).state
  const next = reduce(first, { "print.mc_percent": { future: 1 } }, 2).state

  assert.deepEqual(first.progress.percent, Reading.Present({ value: 40, observedAt: 1 }))
  assert.deepEqual(next.progress.percent, first.progress.percent)
})

test("a dotted category that becomes an object keeps the time of the reading that shares its path", () => {
  const first = reduce(initialState("000FAKE00000001"), { print: { mc_percent: 40 }, "print.mc_percent": 0 }, 1).state
  const next = reduce(first, { "print.mc_percent": { future: 1 } }, 2).state

  assert.deepEqual(first.progress.percent, Reading.Present({ value: 40, observedAt: 1 }))
  assert.deepEqual(next.progress.percent, first.progress.percent)
})
