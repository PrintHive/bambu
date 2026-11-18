import assert from "node:assert/strict"
import { initialState, Lifecycle, reduce } from "../src/index.ts"
import type { LifecycleEvent } from "../src/index.ts"
import { test } from "./support/harness.ts"

/** Steps the lifecycle through a list of observations; `null` is a lost connection. */
const walk = (observations: ReadonlyArray<readonly [string, string] | null>, from = Lifecycle.initial) => {
  let lifecycle = from
  const events: LifecycleEvent[] = []

  for (const observation of observations) {
    if (observation === null) {
      lifecycle = Lifecycle.goOffline(lifecycle)
      continue
    }

    const step = Lifecycle.step(lifecycle, observation[0], observation[1])
    lifecycle = step.lifecycle
    events.push(...step.events)
  }

  return { lifecycle, events }
}

test("rule 4: OFFLINE to RUNNING adopts the job without a start", () => {
  assert.deepEqual(walk([["RUNNING", "7"]]).events, [Lifecycle.JobAdopted({ taskId: "7", gcodeState: "RUNNING" })])
  assert.deepEqual(walk([["RUNNING", "7"], null, ["RUNNING", "7"]]).events.map((event) => event._tag), ["JobAdopted", "JobAdopted"])
})

test("rule 4: OFFLINE to PAUSE recovers the job", () => {
  assert.deepEqual(walk([["PAUSE", "7"]]).events, [Lifecycle.JobRecovered({ taskId: "7" })])
  assert.deepEqual(walk([["RUNNING", "7"], null, ["PAUSE", "7"]]).events.at(-1), Lifecycle.JobRecovered({ taskId: "7" }))
})

test("rule 4: a revision from FINISH to FAILED is ignored", () => {
  const online = walk([["IDLE", "1"], ["RUNNING", "7"], ["FINISH", "7"], ["FAILED", "7"]])

  assert.deepEqual(online.events.map((event) => event._tag), ["JobStarted", "JobEnded"])
  assert.deepEqual(online.events.at(-1), Lifecycle.JobEnded({ taskId: "7", outcome: "FINISH" }))
  assert.equal(online.lifecycle.gcodeState, "FINISH")
  assert.deepEqual(walk([["FINISH", "7"], null, ["FAILED", "7"]]).events, [])
  // A different task failing is not a revision.
  assert.deepEqual(walk([["FINISH", "7"], ["RUNNING", "8"], ["FAILED", "8"]]).events.at(-1), Lifecycle.JobEnded({ taskId: "8", outcome: "FAILED" }))
})

test("an observed start, pause, resume and finish each carry the task id", () => {
  const { events } = walk([["IDLE", "0"], ["PREPARE", "7"], ["RUNNING", "7"], ["PAUSE", "7"], ["RUNNING", "7"], ["FINISH", "7"]])

  assert.deepEqual(events, [
    Lifecycle.JobStarted({ taskId: "7", gcodeState: "PREPARE" }),
    Lifecycle.JobPaused({ taskId: "7" }),
    Lifecycle.JobResumed({ taskId: "7" }),
    Lifecycle.JobEnded({ taskId: "7", outcome: "FINISH" })
  ])
})

test("losing observation is not a stop, and a job that ended while offline still ends", () => {
  const lost = walk([["RUNNING", "7"], null])

  assert.deepEqual(lost.events.map((event) => event._tag), ["JobAdopted"])
  assert.equal(lost.lifecycle.online, false)
  assert.equal(lost.lifecycle.gcodeState, "RUNNING")
  assert.deepEqual(walk([["RUNNING", "7"], null, ["FAILED", "7"]]).events.at(-1), Lifecycle.JobEnded({ taskId: "7", outcome: "FAILED" }))
  // A terminal state found after reconnecting, for a job never seen running, is not an end.
  assert.deepEqual(walk([["FINISH", "7"]]).events, [])
})

test("the lifecycle steps only on reports that carried gcode_state", () => {
  const first = reduce(initialState("01PFAKE00000001"), { print: { gcode_state: "RUNNING", task_id: "7" } }, 1).state
  const adopted = Lifecycle.observe(Lifecycle.initial, first, 1)

  assert.deepEqual(adopted.events, [Lifecycle.JobAdopted({ taskId: "7", gcodeState: "RUNNING" })])

  const next = reduce(first, { print: { wifi_signal: "-50dBm" } }, 2).state

  assert.deepEqual(Lifecycle.observe(Lifecycle.goOffline(adopted.lifecycle), next, 2).events, [])
})
