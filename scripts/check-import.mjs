import assert from "node:assert/strict"
import { initialState, reduce, Reading } from "../dist/index.js"

const result = reduce(initialState("000FAKE00000001"), { print: { mc_percent: 25 } }, 1000)

Reading.match(result.state.progress.percent, {
  Present: ({ value }) => assert.equal(value, 25),
  Absent: () => assert.fail("Missing progress"),
  Unknown: () => assert.fail("Unknown progress"),
  Unsupported: () => assert.fail("Unsupported progress"),
  Invalid: () => assert.fail("Invalid progress")
})
