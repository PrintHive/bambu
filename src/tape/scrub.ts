import { Predicate, type Schema } from "effect"
import { isObject } from "../wire/report.ts"
import type { Tape, TapeFrame } from "./format.ts"

// Ported from PrintHive hive's TapeScrubber (apps/hive-link/src/scripts/mock-printer/tape-scrub.ts),
// extended to zero-padded and IPv6 addresses, URLs, job names and cloud task ids, device and user names,
// and Wi-Fi names under any key.

const SERIAL_FIELD = /(^|[_-])(sn|serial([_-]?number)?|ams_id|dev_id)$/i

const PRIVATE_FIELD =
  /^(.*ssid|host(name)?|host_name|access[_-]?(code|token)|password|.*mac([_-]?address)?|dev(ice)?_(product_)?name|wifi_name|user[_-]?id|uid|.*url)$/i

/** AMS chip and spool RFID identifiers are hardware ids; zeros keep their length. */
const ZEROED_FIELD = /^(chip_id|tag_uid|tray_uuid)$/

/** A job name is whatever the farm printed, which is the owner's business, not protocol. */
const JOB_FIELD = /^(subtask_name|gcode_file)$/

/** Cloud task, project and profile ids tie a capture to an account; they become small synthetic numbers. */
const TASK_FIELD = /^(task_id|subtask_id|project_id|profile_id|job_id|design_id)$/

/** Version fields may hold `01.09.00.01`, which elsewhere would be an address. */
const VERSION_FIELD = /(^|_)(ver|version|firmware)$/i

/** `0`, `-1` and empty mean "no task", so they carry nothing and stay. */
const UNSET_ID = /^(|0+|-1)$/

export const SCRUBBED_SERIAL = /^[A-Z0-9]{3}MOCK\d{8}$/
export const SCRUBBED_JOB = "scrubbed-job"
export const SCRUBBED_PAYLOAD = "[scrubbed unparsed payload]"
export const SCRUBBED_URL = "<redacted-url>"
const DOCUMENTATION_IP = "192.0.2.1"
const DOCUMENTATION_IPV6 = "2001:db8::1"
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

/** IPv6 literals: eight groups, or a `::` compressed form; optionally bracketed or with a `%zone`. */
export const IPV6_TEXT =
  /(?<![\w:.])\[?(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*))(?:%[\w.-]+)?\]?(?!\w)/gi

const DOTTED_QUAD = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g
const MAC = /\b[\da-f]{2}(?:[:-][\da-f]{2}){5}\b/gi

/** Bambu printer and module serials: 15 or 16 uppercase characters, digit first, with at least one letter. */
export const SERIAL_TEXT = /\b(?=[0-9A-Z]*[A-Z])[0-9][0-9A-Z]{14,15}\b/g

/** A whole value shaped like a Bambu firmware or module version, such as `01.09.00.01`. */
export const isVersionText = (text: string): boolean => /^\d{2}(\.\d{2}){3}$/.test(text)

/**
 * Replaces the identifiers in a captured tape with synthetic ones. Use one scrubber per tape: it maps
 * each serial to the same synthetic serial everywhere, so module identity survives across frames.
 */
export class TapeScrubber {
  private readonly serials = new Map<string, string>()
  private readonly tasks = new Map<string, number>()

  private task(value: Schema.Json): Schema.Json {
    const text = String(value)

    if (UNSET_ID.test(text)) return value

    const synthetic = this.tasks.get(text) ?? this.tasks.size + 1

    this.tasks.set(text, synthetic)

    return Predicate.isNumber(value) ? synthetic : String(synthetic)
  }

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
      .replace(URL_TEXT, SCRUBBED_URL)
      .replace(SERIAL_TEXT, (serial) => this.serial(serial))
      .replace(DOTTED_QUAD, DOCUMENTATION_IP)
      .replace(MAC, "<redacted>")
      .replace(IPV6_TEXT, DOCUMENTATION_IPV6)
  }

  scrub(value: Schema.Json, key = ""): Schema.Json {
    if (PRIVATE_FIELD.test(key)) return ""

    if (key === "raw") return SCRUBBED_PAYLOAD

    if (/^ip([_-]?address)?$/i.test(key) && !Predicate.isString(value)) return 0

    if (key === "mask") return 0

    if (ZEROED_FIELD.test(key)) return "0".repeat(String(value).length)

    if (JOB_FIELD.test(key)) return value === "" ? "" : SCRUBBED_JOB

    if (TASK_FIELD.test(key)) return this.task(value)

    if (VERSION_FIELD.test(key) && Predicate.isString(value) && isVersionText(value)) return value

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
