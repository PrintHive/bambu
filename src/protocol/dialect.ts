import { Record } from "effect"
import { models } from "@printhive/bambu-models"
import type { Family, ModelId } from "@printhive/bambu-models"
import type { ExternalSpoolId, MappingFormat } from "./ams.ts"
import type { CommandTag } from "./commands.ts"
import * as Fact from "./provenance.ts"

/** Whether a model accepts a command. `provisional` means a source suggests it and nothing has verified it. */
export type Support = "supported" | "unsupported" | "provisional"

/** How a model keeps the client's state whole: the client asks for `pushall` on a period, or the printer pushes. */
export type PushallCadence = { readonly every: number } | "self-pushing"

/** The `sequence_id` a `get_version` reply carries: the request's, or a fixed value. */
export type VersionReplySequence = "echo" | { readonly fixed: string }

/** What marks a `push_status` report as a full snapshot rather than a partial one. */
export type FullReportRule = "msg-0" | "has-gcode_state"

/**
 * How one model's firmware talks, as data. Every field names its source, so a dialect diff against a new tape lists
 * what is still unverified. Every `CommandTag` must be declared, so a new protocol row fails to compile until each
 * model says whether it accepts it.
 */
export interface Dialect {
  readonly model: ModelId | undefined
  /** How long the client waits after its subscription is granted before `get_version`, in milliseconds. */
  readonly settleAfterSubscribe: Fact.Fact<number>
  readonly pushall: Fact.Fact<PushallCadence>
  readonly getVersionSequence: Fact.Fact<VersionReplySequence>
  readonly fullReport: Fact.Fact<FullReportRule>
  readonly externalSpools: Fact.Fact<ReadonlyArray<ExternalSpoolId>>
  readonly mappingFormat: Fact.Fact<MappingFormat>
  /** How long a written command waits for its reply before it resolves as Ambiguous, in milliseconds. */
  readonly commandTimeout: Fact.Fact<number>
  readonly commands: { readonly [T in CommandTag]: Fact.Fact<Support> }
}

const p1sTape = "p1s-01.09.00.00/idle-2026-09-18.jsonl"
const rule5 = "proposal rule 5 (from the bambu-node inventory)"
const unverifiedCommand = "no tape shows this command on this model; the protocol row comes from proposal rules 1, 2 and 9"

const settle = Fact.inferred(2_000, `${rule5}: subscribe, wait 2 s, get_version, then pushall`)

const cadence = (family: Family): Fact.Fact<PushallCadence> => {
  if (family === "X1") return Fact.inferred("self-pushing", `${rule5}: an X1 pushes on its own`)

  if (family === "P1" || family === "A1" || family === "A2") {
    return Fact.inferred({ every: 300_000 }, `${rule5}: P1, A1 and A2L repeat pushall every 5 minutes`)
  }

  return Fact.inferred({ every: 300_000 }, "rule 5 does not cover this family; a periodic pushall is read-only, so it is the safe default")
}

const versionSequence = (id: ModelId): Fact.Fact<VersionReplySequence> => {
  if (id === "P1S") return Fact.tape("echo", `${p1sTape} t=9.24 answers get_version sequence_id "0" with "0"`)

  if (id === "X1C") return Fact.inferred({ fixed: "2021" }, `${rule5}: an X1C answers get_version with sequence_id "2021"`)

  return Fact.inferred("echo", "OpenBambuAPI mqtt.md: replies echo the request's sequence_id (factual tier)")
}

const fullReport = (id: ModelId): Fact.Fact<FullReportRule> => {
  if (id === "P1S") return Fact.tape("msg-0", `${p1sTape} t=11.995 answers pushall with msg 0; later partial reports carry msg 1`)

  if (id === "A1") return Fact.communityMit("msg-0", "test/fixtures/pybambu/MOCK-A1.json pushall has msg 0")

  if (id === "X1C") return Fact.communityMit("msg-0", "test/fixtures/pybambu/MOCK-X1CMULTIAMS.json pushall has msg 0")

  return Fact.inferred("has-gcode_state", "synthesis.md red flag 1: which field marks a full snapshot is open; no source for this model")
}

const externalSpools = (id: ModelId): Fact.Fact<ReadonlyArray<ExternalSpoolId>> => {
  if (id === "P1S") return Fact.tape([254], `${p1sTape} t=11.995 print.vt_tray.id "254"`)

  if (id === "H2D") return Fact.communityMit([254, 255], "test/fixtures/pybambu/MOCK-H2D.json print.vir_slot ids 254 and 255")

  return models[id].extruders?.value === 2
    ? Fact.inferred([254, 255], "proposal rule 9: external spools are 254 and 255; one per extruder on a two-extruder model")
    : Fact.inferred([254], "proposal rule 9; a one-extruder model is assumed to have one external spool, 254")
}

const mappingFormat = (id: ModelId): Fact.Fact<MappingFormat> => id === "H2D" || id === "H2S"
  ? Fact.inferred("ams_mapping2", "proposal rule 9: mapping shapes differ on H2D and H2S. The ams_mapping2 pair shape has no clean-room source")
  : Fact.inferred("ams_mapping", "OpenBambuAPI mqtt.md documents project_file ams_mapping as a list of tray indexes (factual tier)")

const commands = (id: ModelId): Dialect["commands"] => {
  const unverified = Fact.inferred<Support>("supported", unverifiedCommand)
  const onTape = (ref: string) => (id === "P1S" ? Fact.tape<Support>("supported", `${p1sTape} ${ref}`) : unverified)

  return {
    PushAll: onTape("t=11.143 pushall, answered at t=11.995"),
    GetVersion: onTape("t=9.141 get_version, answered at t=9.24"),
    Pause: onTape("t=14.144 pause, acknowledged at t=14.182"),
    Resume: onTape("t=16.145 resume, acknowledged at t=16.211"),
    Stop: unverified,
    ProjectFile: unverified,
    ChangeFilament: unverified,
    SetBedTemperature: unverified
  }
}

const timeout = Fact.inferred(10_000, "a default; no source gives a reply deadline")

const dialectOf = (id: ModelId): Dialect => ({
  model: id,
  settleAfterSubscribe: settle,
  pushall: cadence(models[id].family.value),
  getVersionSequence: versionSequence(id),
  fullReport: fullReport(id),
  externalSpools: externalSpools(id),
  mappingFormat: mappingFormat(id),
  commandTimeout: timeout,
  commands: commands(id)
})

/** One dialect per registry model. A model the registry adds fails to compile here until it has one. */
export const dialects: { readonly [K in ModelId]: Dialect } = Record.map(models, (_, id) => dialectOf(id))

/**
 * The dialect for a printer whose model is not resolved. It assumes the most cautious behavior: a periodic `pushall`,
 * which is read-only, and a sequence echo.
 */
export const unknownDialect: Dialect = {
  model: undefined,
  settleAfterSubscribe: settle,
  pushall: Fact.inferred({ every: 300_000 }, "unknown model; a periodic pushall is read-only, so it is the safe default"),
  getVersionSequence: Fact.inferred("echo", "unknown model; OpenBambuAPI mqtt.md says replies echo sequence_id (factual tier)"),
  fullReport: Fact.inferred("has-gcode_state", "unknown model; synthesis.md red flag 1"),
  externalSpools: Fact.inferred([254], "unknown model; proposal rule 9"),
  mappingFormat: Fact.inferred("ams_mapping", "unknown model; OpenBambuAPI mqtt.md (factual tier)"),
  commandTimeout: timeout,
  commands: {
    PushAll: Fact.inferred("supported", "unknown model"),
    GetVersion: Fact.inferred("supported", "unknown model"),
    Pause: Fact.inferred("supported", "unknown model"),
    Resume: Fact.inferred("supported", "unknown model"),
    Stop: Fact.inferred("supported", "unknown model"),
    ProjectFile: Fact.inferred("supported", "unknown model"),
    ChangeFilament: Fact.inferred("supported", "unknown model"),
    SetBedTemperature: Fact.inferred("supported", "unknown model")
  }
}

export const dialectFor = (model: ModelId | undefined): Dialect => (model === undefined ? unknownDialect : dialects[model])
