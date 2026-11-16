import { Predicate, type Schema } from "effect"
import { isObject } from "../wire/report.ts"
import type { Tape, TapeFrame } from "./format.ts"

// Ported from PrintHive hive's TapeScrubber (apps/hive-link/src/scripts/mock-printer/tape-scrub.ts),
// with two additions: zero-padded IPv4 addresses and print job names.

const SERIAL_FIELD = /(^|[_-])(sn|serial([_-]?number)?|ams_id|dev_id)$/i
const PRIVATE_FIELD = /^(.*ssid|host(name)?|host_name|access[_-]?(code|token)|password|.*mac([_-]?address)?)$/i

/** AMS chip and spool RFID identifiers are hardware ids; zeros keep their length. */
const ZEROED_FIELD = /^(chip_id|tag_uid|tray_uuid)$/

/** A job name is whatever the farm printed, which is the owner's business, not protocol. */
const JOB_FIELD = /^(subtask_name|gcode_file)$/

export const SCRUBBED_SERIAL = /^[A-Z0-9]{3}MOCK\d{8}$/
export const SCRUBBED_JOB = "scrubbed-job"
export const SCRUBBED_PAYLOAD = "[scrubbed unparsed payload]"
const DOCUMENTATION_IP = "192.0.2.1"
const DOTTED_QUAD = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g
const MAC = /\b[\da-f]{2}(?:[:-][\da-f]{2}){5}\b/gi

/** Bambu printer and module serials: 15 or 16 uppercase characters, digit first, with at least one letter. */
export const SERIAL_TEXT = /\b(?=[0-9A-Z]*[A-Z])[0-9][0-9A-Z]{14,15}\b/g

/**
 * Firmware versions such as `01.09.00.01` are dotted quads too. They always have two-digit parts and at
 * least one leading zero, which an address written by a person or a printer never needs.
 */
export const isFirmwareVersion = (quad: string): boolean => /^\d{2}(\.\d{2}){3}$/.test(quad) && /(^|\.)0/.test(quad)

/**
 * Replaces the identifiers in a captured tape with synthetic ones. Use one scrubber per tape: it maps
 * each serial to the same synthetic serial everywhere, so module identity survives across frames.
 */
export class TapeScrubber {
  private readonly serials = new Map<string, string>()

  private serial(value: string): string {
    if (value === "" || SCRUBBED_SERIAL.test(value)) return value

    const existing = this.serials.get(value)

    if (existing !== undefined) return existing

    const prefix = /^[A-Z0-9]{3}/.exec(value)?.[0] ?? "XXX"
    const synthetic = `${prefix}MOCK${String(this.serials.size + 1).padStart(8, "0")}`

    this.serials.set(value, synthetic)

    return synthetic
  }

  private text(value: string): string {
    let text = value.replace(/device\/([^/\s]+)\//g, (_match, serial: string) => `device/${this.serial(serial)}/`)

    // Known serials are replaced only as whole tokens long enough to be serials; a short sn such as "1"
    // must not rewrite every digit in free text.
    for (const [original, synthetic] of this.serials) {
      if (original.length < 8) continue

      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

      text = text.replace(new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`, "g"), synthetic)
    }

    return text
      .replace(SERIAL_TEXT, (serial) => this.serial(serial))
      .replace(DOTTED_QUAD, (quad) => (isFirmwareVersion(quad) ? quad : DOCUMENTATION_IP))
      .replace(MAC, "<redacted>")
  }

  scrub(value: Schema.Json, key = ""): Schema.Json {
    if (PRIVATE_FIELD.test(key)) return ""

    if (key === "raw") return SCRUBBED_PAYLOAD

    if (/^ip([_-]?address)?$/i.test(key) && !Predicate.isString(value)) return 0

    if (key === "mask") return 0

    if (ZEROED_FIELD.test(key)) return "0".repeat(String(value).length)

    if (JOB_FIELD.test(key)) return value === "" ? "" : SCRUBBED_JOB

    if (SERIAL_FIELD.test(key)) {
      // A numeric ams_id selects an AMS unit or the external spool (255).
      if (key === "ams_id" && /^[0-9]{1,3}$/.test(String(value))) return value

      return this.serial(String(value))
    }

    if (Predicate.isString(value)) return this.text(value)

    if (Array.isArray(value)) return value.map((entry) => this.scrub(entry))

    return isObject(value) ? this.scrubObject(value) : value
  }

  scrubObject(value: Schema.JsonObject): Schema.JsonObject {
    return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, this.scrub(entry, field)]))
  }
}

/** Scrubs every frame of a tape, topics included, with one scrubber so serials pair up across frames. */
export const scrubTape = (tape: Tape): Tape => {
  const scrubber = new TapeScrubber()

  const scrubFrame = (frame: TapeFrame): TapeFrame => {
    const topic = String(scrubber.scrub(frame.topic))

    return "frame" in frame
      ? { ...frame, topic, frame: scrubber.scrubObject(frame.frame) }
      : { ...frame, topic, raw: SCRUBBED_PAYLOAD }
  }

  return { header: tape.header, frames: tape.frames.map(scrubFrame) }
}
