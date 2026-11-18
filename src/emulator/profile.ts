// The emulator's own model of each printer. It deliberately does not import the client's dialects: a printer that
// reads the client's assumptions agrees with the client by construction, and that proves nothing. Where both hold
// the same fact, both cite the same source, and a tape decides between them.
import { Record } from "effect"
import type { Schema } from "effect"
import { models } from "@printhive/bambu-models"
import type { Model, ModelId } from "@printhive/bambu-models"
import * as Fact from "../protocol/provenance.ts"
import { p1sModules, p1sReport } from "./seed-p1s.ts"

/** How the printer answers a request. */
export type Reply = "ack" | "full-report" | "version" | "silent"

/** What a request does to the emulated world. */
export type WorldEffect = "none" | "pause" | "resume" | "stop" | "start-print" | "change-filament" | "gcode" | "set-bed"

export interface Behavior {
  readonly reply: Fact.Fact<Reply>
  readonly effect: Fact.Fact<WorldEffect>
}

/** How the printer pushes reports without being asked. */
export type Pushing = { readonly partialEvery: number } | { readonly fullEvery: number }

export interface Profile {
  readonly model: ModelId
  readonly firmware: Fact.Fact<string>
  readonly pushing: Fact.Fact<Pushing>
  /** The `sequence_id` of a `get_version` reply. */
  readonly versionSequence: Fact.Fact<"echo" | { readonly fixed: string }>
  /** Whether a full report carries `msg: 0`. */
  readonly fullReportMarker: Fact.Fact<boolean>
  /** How long a started print stays in PREPARE before RUNNING, in milliseconds. */
  readonly prepareFor: Fact.Fact<number>
  /** Requests by wire command, under the category they arrive in. Any other request gets no reply. */
  readonly commands: { readonly [command: string]: Behavior }
  readonly seed: Fact.Fact<{ readonly report: Schema.JsonObject; readonly modules: ReadonlyArray<Schema.JsonObject> }>
}

const tapeRef = "p1s-01.09.00.00/idle-2026-09-18.jsonl"

const unverifiedBehavior = (reply: Reply, effect: WorldEffect, ref: string): Behavior => ({
  reply: Fact.inferred(reply, ref),
  effect: Fact.inferred(effect, ref)
})

const commandsFor = (id: ModelId): Profile["commands"] => {
  const p1s = id === "P1S"
  const docs = "OpenBambuAPI mqtt.md: replies echo command and sequence_id with result success (factual tier)"

  return {
    pushall: p1s
      ? { reply: Fact.tape("full-report", `${tapeRef} t=11.143 pushall answered by a full push_status at t=11.995`), effect: Fact.tape("none", `${tapeRef} idle`) }
      : unverifiedBehavior("full-report", "none", "OpenBambuAPI mqtt.md: pushall is answered by push_status (factual tier)"),
    get_version: p1s
      ? { reply: Fact.tape("version", `${tapeRef} t=9.141 get_version answered at t=9.24`), effect: Fact.tape("none", `${tapeRef}`) }
      : unverifiedBehavior("version", "none", "OpenBambuAPI mqtt.md info.get_version (factual tier)"),
    // The tape paused and resumed an idle printer: both were acknowledged with success and nothing changed. That an
    // active print pauses is inferred.
    pause: {
      reply: p1s ? Fact.tape("ack", `${tapeRef} t=14.182 pause acknowledged with result success`) : Fact.inferred("ack", docs),
      effect: Fact.inferred("pause", "a RUNNING print pauses; the P1S tape shows only that an idle printer acks and stays FINISH")
    },
    resume: {
      reply: p1s ? Fact.tape("ack", `${tapeRef} t=16.211 resume acknowledged with result success`) : Fact.inferred("ack", docs),
      effect: Fact.inferred("resume", "a PAUSE print resumes; the P1S tape shows only that an idle printer acks and stays FINISH")
    },
    stop: unverifiedBehavior("ack", "stop", "proposal rule 2: a stop is acknowledged; an active print ends FAILED (inferred)"),
    project_file: unverifiedBehavior("ack", "start-print", "proposal rule 1 and OpenBambuAPI mqtt.md print.project_file (factual tier)"),
    ams_change_filament: unverifiedBehavior("ack", "change-filament", "OpenBambuAPI mqtt.md print.ams_change_filament (factual tier)"),
    gcode_line: unverifiedBehavior("ack", "gcode", "OpenBambuAPI mqtt.md print.gcode_line (factual tier)"),
    set_bed_temp: unverifiedBehavior("ack", "set-bed", "synthesis.md grafts: set_bed_temp exists where fun bit 39 is set")
  }
}

const syntheticSeed = (id: ModelId) => {
  const model: Model = models[id]

  return Fact.inferred({
  report: {
    gcode_state: "IDLE",
    mc_percent: 0,
    mc_remaining_time: 0,
    nozzle_temper: 25,
    nozzle_target_temper: 0,
    bed_temper: 25,
    bed_target_temper: 0,
    task_id: "0",
    subtask_id: "0",
    subtask_name: "",
    print_error: 0,
    wifi_signal: "-50dBm",
    hms: [],
    vt_tray: { id: "254", tray_type: "", tray_color: "00000000" }
  },
  modules: [{ name: "ota", sw_ver: "00.00.00.00", hw_ver: "OTA", product_name: model.productName?.value ?? model.name.value }]
}, "a synthetic idle printer; no tape exists for this model")
}

const pushingFor = (id: ModelId): Fact.Fact<Pushing> => {
  if (id === "P1S") return Fact.tape({ partialEvery: 4_000 }, `${tapeRef} partial push_status at t=13.892, 17.898 and 21.958`)

  return models[id].family.value === "X1"
    ? Fact.inferred({ fullEvery: 2_000 }, "OpenBambuAPI mqtt.md: an X1 sends the full object every time (factual tier); the period is a guess")
    : Fact.inferred({ partialEvery: 4_000 }, `assumed like the P1S tape (${tapeRef})`)
}

const versionSequenceOf = (id: ModelId): Profile["versionSequence"] => {
  if (id === "P1S") return Fact.tape("echo", `${tapeRef} t=9.24 echoes sequence_id "0"`)

  if (id === "X1C") return Fact.inferred({ fixed: "2021" }, "proposal rule 5: an X1C answers get_version with sequence_id 2021")

  return Fact.inferred("echo", "OpenBambuAPI mqtt.md (factual tier)")
}

const profileOf = (id: ModelId): Profile => ({
  model: id,
  firmware: id === "P1S" ? Fact.tape("01.09.00.00", `${tapeRef} header`) : Fact.inferred("00.00.00.00", "no tape for this model"),
  pushing: pushingFor(id),
  versionSequence: versionSequenceOf(id),
  fullReportMarker: id === "P1S" ? Fact.tape(true, `${tapeRef} t=11.995 msg 0`) : Fact.inferred(true, "assumed like the P1S tape"),
  prepareFor: Fact.inferred(2_000, "no tape has a print start; a short PREPARE keeps scenarios fast"),
  commands: commandsFor(id),
  seed: id === "P1S" ? Fact.tape({ report: p1sReport, modules: p1sModules }, `${tapeRef} t=9.24 and t=11.995`) : syntheticSeed(id)
})

/** One emulator profile per registry model. */
export const profiles: { readonly [K in ModelId]: Profile } = Record.map(models, (_, id) => profileOf(id))

/** Every fact a profile rests on, labelled. Emulator output prints these, so an UNVERIFIED behavior says so. */
export const describe = (profile: Profile): ReadonlyArray<string> => [
  `firmware ${Fact.label(profile.firmware)}`,
  `pushing ${Fact.label(profile.pushing)}`,
  `get_version sequence ${Fact.label(profile.versionSequence)}`,
  `full report marker ${Fact.label(profile.fullReportMarker)}`,
  `prepare ${Fact.label(profile.prepareFor)}`,
  `seed ${Fact.label(profile.seed)}`,
  ...Object.entries(profile.commands).flatMap(([command, behavior]) => [
    `${command} reply ${Fact.label(behavior.reply)}`,
    `${command} effect ${Fact.label(behavior.effect)}`
  ])
]
