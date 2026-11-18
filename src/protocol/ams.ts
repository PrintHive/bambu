import { Match, Schema } from "effect"
import * as Fact from "./provenance.ts"

/** One AMS tray. `ams` is the unit index and `slot` the tray within it, 0 to 3. */
export const AmsSlot = Schema.TaggedStruct("AmsSlot", {
  ams: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 62 })),
  slot: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
})

/** An external spool. Bambu addresses them as 254 and 255, past every AMS tray index. */
export const ExternalSpool = Schema.TaggedStruct("ExternalSpool", { id: Schema.Literals([254, 255]) })

/** Where filament loads from: an AMS tray or an external spool. */
export const FilamentTarget = Schema.Union([AmsSlot, ExternalSpool])

export type FilamentTarget = typeof FilamentTarget.Type

export type ExternalSpoolId = (typeof ExternalSpool.Type)["id"]

export const addressingFacts = {
  trayIndex: Fact.inferred("ams*4+slot", "proposal rule 9; OpenBambuAPI mqtt.md documents tray_now as ams_id*4 + tray_id (factual tier)"),
  external254: Fact.tape(254, "p1s-01.09.00.00/idle-2026-09-18.jsonl t=11.995 print.vt_tray.id \"254\""),
  external255: Fact.communityMit(255, "test/fixtures/pybambu/MOCK-H2D.json print.vir_slot ids 254 and 255")
} as const

/** The global tray index the wire uses: `ams*4+slot` for an AMS tray, 254 or 255 for an external spool. */
export const trayIndex = (target: FilamentTarget): number => Match.valueTags(target, {
  AmsSlot: ({ ams, slot }) => ams * 4 + slot,
  ExternalSpool: ({ id }) => id
})

/**
 * Which filament feeds each color of a print file, in the file's color order. `undefined` leaves a color unused.
 */
export type AmsMapping = ReadonlyArray<FilamentTarget | undefined>

/** Which mapping fields a model expects in `project_file`. */
export type MappingFormat = "ams_mapping" | "ams_mapping2"

export type MappingPair = { readonly ams_id: number; readonly slot_id: number }

/** The `project_file` fields `encodeMapping` writes. A type alias, so it spreads into a JSON body. */
export type MappingFields =
  | { readonly use_ams: boolean; readonly ams_mapping: ReadonlyArray<number> }
  | { readonly use_ams: boolean; readonly ams_mapping: ReadonlyArray<number>; readonly ams_mapping2: ReadonlyArray<MappingPair> }

/**
 * The mapping fields of `project_file`. Every model gets `ams_mapping`, a list of global tray indexes with -1 for an
 * unused color. `ams_mapping2` models also get the pairs `{ ams_id, slot_id }`, with an external spool as its id
 * and slot 0, and an unused color as 255 and 255. That second format has no clean-room source; see the dialect fact.
 */
export const encodeMapping = (mapping: AmsMapping, format: MappingFormat): MappingFields => {
  const flat = mapping.map((target) => (target === undefined ? -1 : trayIndex(target)))
  const useAms = mapping.some((target) => target !== undefined && Schema.is(AmsSlot)(target))

  if (format === "ams_mapping") return { use_ams: useAms, ams_mapping: flat }

  const pairs = mapping.map((target): MappingPair => target === undefined ? { ams_id: 255, slot_id: 255 } : Match.valueTags(target, {
    AmsSlot: ({ ams, slot }) => ({ ams_id: ams, slot_id: slot }),
    ExternalSpool: ({ id }) => ({ ams_id: id, slot_id: 0 })
  }))

  return { use_ams: useAms, ams_mapping: flat, ams_mapping2: pairs }
}

/**
 * `print.fun` is a hexadecimal capability mask; pybambu's X1C and H2D mocks carry one. Returns undefined for a value
 * that is not hexadecimal, so a malformed mask never reads as "no capabilities".
 */
export const capabilityBit = (fun: string, bit: number): boolean | undefined => {
  if (!/^[0-9A-Fa-f]+$/.test(fun)) return undefined

  return ((BigInt(`0x${fun}`) >> BigInt(bit)) & 1n) === 1n
}

export const capabilityFacts = {
  funIsHex: Fact.communityMit("hex string", "test/fixtures/pybambu/MOCK-X1CMULTIAMS.json and MOCK-H2D.json print.fun"),
  setBedTempBit: Fact.inferred(39, "synthesis.md grafts: the encoder chooses set_bed_temp or M140 from fun bit 39")
} as const
