import { Data, Predicate } from "effect"
import type { PrinterState } from "./reduce.ts"

/**
 * Job lifecycle evidence, derived from `gcode_state` changes. Every event carries the task id the printer reported
 * with it, so a caller matches a Start Print by task id rather than by "some job became active".
 *
 * - `JobStarted`: an observed change from not printing to printing.
 * - `JobAdopted`: the first observation after being offline found a job already printing. It is not a start.
 * - `JobRecovered`: the first observation after being offline found a job paused.
 * - `JobEnded`: an observed change from printing to FINISH, FAILED or IDLE. Losing observation is never an end.
 */
export type LifecycleEvent = Data.TaggedEnum<{
  JobStarted: { readonly taskId: string | undefined; readonly gcodeState: string }
  JobAdopted: { readonly taskId: string | undefined; readonly gcodeState: string }
  JobRecovered: { readonly taskId: string | undefined }
  JobPaused: { readonly taskId: string | undefined }
  JobResumed: { readonly taskId: string | undefined }
  JobEnded: { readonly taskId: string | undefined; readonly outcome: "FINISH" | "FAILED" | "IDLE" }
}>

export const { JobStarted, JobAdopted, JobRecovered, JobPaused, JobResumed, JobEnded, $match: match } = Data.taggedEnum<LifecycleEvent>()

/**
 * What the lifecycle remembers. `online` is false until a report in the current epoch carries `gcode_state`, and
 * again once the epoch ends. The last observed state and task survive going offline, so a job that ended while
 * the link was down still ends.
 */
export interface Lifecycle {
  readonly online: boolean
  readonly gcodeState: string | undefined
  readonly taskId: string | undefined
}

export const initial: Lifecycle = { online: false, gcodeState: undefined, taskId: undefined }

/** Observation was lost. This is not evidence of anything about the job. */
export const goOffline = (lifecycle: Lifecycle): Lifecycle => ({ ...lifecycle, online: false })

const printing = new Set(["PREPARE", "SLICING", "RUNNING"])

const active = (state: string | undefined): boolean => state !== undefined && (printing.has(state) || state === "PAUSE")

const ending = (state: string): state is "FINISH" | "FAILED" | "IDLE" => state === "FINISH" || state === "FAILED" || state === "IDLE"

export interface Step {
  readonly lifecycle: Lifecycle
  readonly events: ReadonlyArray<LifecycleEvent>
}

/** One observed `gcode_state`, with the task id reported alongside it. */
export const step = (previous: Lifecycle, gcodeState: string, taskId: string | undefined): Step => {
  const sameTask = previous.taskId === taskId

  // A firmware revision from FINISH to FAILED for the same task is ignored, online or not (proposal rule 4).
  if (previous.gcodeState === "FINISH" && gcodeState === "FAILED" && sameTask) {
    return { lifecycle: { ...previous, online: true }, events: [] }
  }

  const lifecycle: Lifecycle = { online: true, gcodeState, taskId }
  const events: LifecycleEvent[] = []

  if (!previous.online) {
    if (printing.has(gcodeState)) events.push(JobAdopted({ taskId, gcodeState }))
    else if (gcodeState === "PAUSE") events.push(JobRecovered({ taskId }))
    else if (ending(gcodeState) && active(previous.gcodeState) && sameTask) events.push(JobEnded({ taskId, outcome: gcodeState }))

    return { lifecycle, events }
  }

  const before = previous.gcodeState

  if (printing.has(gcodeState) && (!active(before) || !sameTask)) events.push(JobStarted({ taskId, gcodeState }))
  else if (gcodeState === "PAUSE" && before !== undefined && printing.has(before)) events.push(JobPaused({ taskId }))
  else if (gcodeState === "RUNNING" && before === "PAUSE") events.push(JobResumed({ taskId }))
  else if (ending(gcodeState) && active(before)) events.push(JobEnded({ taskId: previous.taskId, outcome: gcodeState }))

  return { lifecycle, events }
}

/**
 * Steps the lifecycle with a reduced report, but only when that report carried `gcode_state`: a report observed at
 * `now` refreshes the reading's time. State held over from an earlier report or epoch is not a new observation.
 */
export const observe = (previous: Lifecycle, state: PrinterState, now: number): Step => {
  const reading = state.execution.gcodeState

  if (!Predicate.isTagged(reading, "Present") || reading.observedAt !== now) return { lifecycle: previous, events: [] }

  const task = state.job.taskId

  return step(previous, reading.value, Predicate.isTagged(task, "Present") ? task.value : undefined)
}
