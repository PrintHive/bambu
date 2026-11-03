import { Schema } from "effect"
import type { ModelResolution } from "../models/resolve.ts"
import type { Reading, UnsupportedSource } from "./reading.ts"

export interface Field<A = Schema.Json> {
  readonly kind: "field"
  readonly path: string
  readonly schema: Schema.Codec<A, unknown>
  readonly unsupported: (model: ModelResolution | undefined) => UnsupportedSource | undefined
}

export interface Collection<T extends FieldGroup = FieldGroup> {
  readonly kind: "collection"
  readonly path: string
  readonly identity: readonly [string, ...string[]]
  readonly fields: T
}

export interface FieldGroup {
  readonly [key: string]: Field | Collection
}

export type Projection<T extends FieldGroup> = {
  readonly [K in keyof T]: T[K] extends Field<infer A> ? Reading<A>
    : T[K] extends Collection<infer F> ? Reading<ReadonlyMap<string, Projection<F>>> : never
}

const supported = () => undefined
const field = <A extends Schema.Json>(path: string, schema: Schema.Codec<A, unknown>, unsupported: Field<A>["unsupported"] = supported): Field<A> => ({ kind: "field", path, schema, unsupported })
const collection = <const T extends FieldGroup>(path: string, identity: Collection["identity"], fields: T): Collection<T> => ({ kind: "collection", path, identity, fields })

const chamberSensor: Field["unsupported"] = (model) => {
  const fact = model?.facts.chamberSensor

  return model && fact && fact.value !== "real" ? { model: model.id, fact: "chamberSensor", source: fact.source, ref: fact.ref } : undefined
}

const chamberHeating: Field["unsupported"] = (model) => {
  const fact = model?.facts.chamberHeating

  return model && fact?.value === false ? { model: model.id, fact: "chamberHeating", source: fact.source, ref: fact.ref } : undefined
}

const Numeric = Schema.Union([Schema.Finite, Schema.FiniteFromString])

const trayFields = {
  id: field("id", Schema.String),
  type: field("tray_type", Schema.String),
  color: field("tray_color", Schema.String),
  remaining: field("remain", Numeric),
  k: field("k", Numeric)
} satisfies FieldGroup

export const fieldTable = {
  execution: {
    gcodeState: field("print.gcode_state", Schema.String),
    homeFlag: field("print.home_flag", Schema.Finite),
    sdcard: field("print.sdcard", Schema.Boolean),
    nozzleDiameter: field("print.nozzle_diameter", Numeric),
    nozzleType: field("print.nozzle_type", Schema.String)
  },
  progress: {
    percent: field("print.mc_percent", Numeric),
    remainingMinutes: field("print.mc_remaining_time", Numeric),
    layer: field("print.layer_num", Numeric),
    totalLayers: field("print.total_layer_num", Numeric)
  },
  temperature: {
    nozzle: field("print.nozzle_temper", Numeric),
    nozzleTarget: field("print.nozzle_target_temper", Numeric),
    bed: field("print.bed_temper", Numeric),
    bedTarget: field("print.bed_target_temper", Numeric),
    chamber: field("print.chamber_temper", Numeric, chamberSensor),
    chamberTarget: field("print.ctt", Numeric, chamberHeating)
  },
  fans: {
    part: field("print.cooling_fan_speed", Numeric),
    auxiliary: field("print.big_fan1_speed", Numeric),
    chamber: field("print.big_fan2_speed", Numeric),
    heatbreak: field("print.heatbreak_fan_speed", Numeric)
  },
  network: { wifiSignal: field("print.wifi_signal", Schema.String) },
  job: {
    subtaskId: field("print.subtask_id", Schema.String),
    taskId: field("print.task_id", Schema.String),
    name: field("print.subtask_name", Schema.String)
  },
  faults: {
    printError: field("print.print_error", Schema.Finite),
    hms: collection("print.hms", ["attr", "code"], {
      code: field("code", Schema.Finite),
      attr: field("attr", Schema.Finite)
    })
  },
  ams: {
    existBits: field("print.ams.ams_exist_bits", Schema.String),
    trayExistBits: field("print.ams.tray_exist_bits", Schema.String),
    trayNow: field("print.ams.tray_now", Schema.String),
    trayTarget: field("print.ams.tray_tar", Schema.String),
    units: collection("print.ams.ams", ["id"], {
      id: field("id", Schema.String),
      humidity: field("humidity", Numeric),
      temperature: field("temp", Numeric),
      trayExistBits: field("tray_exist_bits", Schema.String),
      trays: collection("tray", ["id"], trayFields)
    })
  },
  externalSpool: {
    id: field("print.vt_tray.id", Schema.Union([Schema.String, Schema.Finite])),
    type: field("print.vt_tray.tray_type", Schema.String),
    color: field("print.vt_tray.tray_color", Schema.String),
    remaining: field("print.vt_tray.remain", Numeric),
    k: field("print.vt_tray.k", Numeric)
  },
  lighting: {
    lights: collection("print.lights_report", ["node"], {
      node: field("node", Schema.String),
      mode: field("mode", Schema.String)
    })
  },
  hardware: {
    modules: collection("info.module", ["name"], {
      name: field("name", Schema.String),
      serial: field("sn", Schema.String),
      softwareVersion: field("sw_ver", Schema.String),
      hardwareVersion: field("hw_ver", Schema.String),
      productName: field("product_name", Schema.String)
    })
  }
} satisfies Readonly<Record<string, FieldGroup>>

export type Sections = { readonly [K in keyof typeof fieldTable]: Projection<(typeof fieldTable)[K]> }

export type Section = keyof Sections

type LeafPaths<T extends FieldGroup> = {
  [K in keyof T & string]: T[K] extends Collection<infer C> ? `${K}.*.${LeafPaths<C>}` : K
}[keyof T & string]

export type StatePath = { [K in Section]: `${K}.${LeafPaths<(typeof fieldTable)[K]>}` }[Section]

export interface FieldRow {
  readonly wirePath: string
  readonly statePath: StatePath
  readonly schema: Field["schema"]
  readonly unsupported: Field["unsupported"]
}

const rows = (group: FieldGroup, wirePrefix: string, statePrefix: string): ReadonlyArray<FieldRow> => {
  const out: FieldRow[] = []

  for (const [key, node] of Object.entries(group)) {
    const wirePath = `${wirePrefix}${node.path}`
    // SAFETY: rows is called only with fieldTable sections and recurses through their declared collection keys.
    const statePath = `${statePrefix}${key}` as StatePath

    if (node.kind === "field") out.push({ wirePath, statePath, schema: node.schema, unsupported: node.unsupported })
    else out.push(...rows(node.fields, `${wirePath}.*.`, `${statePath}.*.`))
  }

  return out
}

export const fieldRows = Object.entries(fieldTable).flatMap(([section, group]) => rows(group, "", `${section}.`))
