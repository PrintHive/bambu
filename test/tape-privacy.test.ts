// Every committed tape must contain only scrubbed identifiers. This repository is public, so a tape that
// fails here must not be committed. Ported from PrintHive hive's tape-privacy guard and extended. Its
// patterns are written separately from the scrubber's on purpose, so a scrubber gap does not hide here too.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Predicate, type Schema } from "effect"
import { isObject } from "../src/wire/report.ts"
import { SCRUBBED_JOB, SCRUBBED_PAYLOAD, SCRUBBED_SERIAL, SCRUBBED_URL } from "../src/tape/scrub.ts"

const test: (name: string, run: () => void) => void = process.versions.bun ? (await import("node:test")).test : (await import("vitest")).test

const SERIAL_FIELD = /(^|[_-])(sn|serial([_-]?number)?|ams_id|dev_id)$/i

const PRIVATE_FIELD =
  /^(.*ssid|host(name)?|host_name|access[_-]?(code|token)|password|.*mac([_-]?address)?|dev(ice)?_(product_)?name|wifi_name|user[_-]?id|uid|.*url)$/i

const TASK_FIELD = /^(task_id|subtask_id|project_id|profile_id|job_id|design_id)$/
const VERSION_FIELD = /(^|_)(ver|version|firmware)$/i
const SERIAL_TEXT = /\b(?=[0-9A-Z]*[A-Z])[0-9][0-9A-Z]{14,15}\b/g
const DOTTED_QUAD = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g
const MAC = /\b[\da-f]{2}(?:[:-][\da-f]{2}){5}\b/i
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

/** Any run with `::`, or eight hex groups, is an IPv6 literal. */
const IPV6 = /(?<![\w:.])\[?(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)/gi

/** Synthetic task ids are small counters; a real cloud id is much longer. */
const syntheticTask = (value: Schema.Json): boolean => /^(|0+|-1|[1-9]\d{0,2})$/.test(String(value))

/** RFC 5737 documentation ranges are the only addresses a tape may hold. */
const documentationIp = (value: string): boolean =>
  value.split(".").every((part) => !part.startsWith("0") || part === "0") && /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(value)

// Messages name the path and the rule, never the value, so a failure does not leak what it found.
const privacyViolations = (value: Schema.Json, path = ""): ReadonlyArray<string> => {
  if (Predicate.isString(value)) {
    const problems: Array<string> = []

    if (MAC.test(value)) problems.push(`${path} contains a MAC address`)

    for (const [quad] of value.matchAll(DOTTED_QUAD)) {
      if (!documentationIp(quad)) problems.push(`${path} contains an IPv4 address`)
    }

    for (const [address] of value.matchAll(IPV6)) {
      if (!/^\[?2001:db8:/i.test(address)) problems.push(`${path} contains an IPv6 address`)
    }

    // A partial redaction leaves hex groups glued to the placeholder.
    if (/[0-9a-f]{1,4}:<redacted>|<redacted>:[0-9a-f]{1,4}/i.test(value)) problems.push(`${path} contains part of an address`)

    for (const [url] of value.matchAll(URL_TEXT)) {
      if (url !== SCRUBBED_URL) problems.push(`${path} contains a URL`)
    }

    for (const [serial] of value.matchAll(SERIAL_TEXT)) {
      if (!SCRUBBED_SERIAL.test(serial)) problems.push(`${path} contains serial-shaped text`)
    }

    for (const match of value.matchAll(/device\/([^/\s]+)\//g)) {
      if (!SCRUBBED_SERIAL.test(match[1] ?? "")) problems.push(`${path} topic names a real serial`)
    }

    return problems
  }

  if (Array.isArray(value)) return value.flatMap((entry, index) => privacyViolations(entry, `${path}[${index}]`))

  if (!isObject(value)) return []

  return Object.entries(value).flatMap(([key, entry]) => {
    const fieldPath = `${path}.${key}`
    // A version field may hold exactly `01.09.00.01`, which anywhere else would be an address.
    const version = VERSION_FIELD.test(key) && Predicate.isString(entry) && /^\d{2}(\.\d{2}){3}$/.test(entry)
    const problems = version ? [] : [...privacyViolations(entry, fieldPath)]

    if (SERIAL_FIELD.test(key) && entry !== "") {
      // A numeric ams_id selects an AMS unit or the external spool (255).
      const slot = key === "ams_id" && /^[0-9]{1,3}$/.test(String(entry))

      if (!slot && (!Predicate.isString(entry) || !SCRUBBED_SERIAL.test(entry))) problems.push(`${fieldPath} is an unscrubbed serial`)
    }

    if (/^ip([_-]?address)?$/i.test(key) && entry !== 0 && (!Predicate.isString(entry) || !documentationIp(entry))) {
      problems.push(`${fieldPath} is a network address`)
    }

    if (PRIVATE_FIELD.test(key) && entry !== "") problems.push(`${fieldPath} is a private field`)

    if (TASK_FIELD.test(key) && !syntheticTask(entry)) problems.push(`${fieldPath} is a cloud task id`)

    if (key === "raw" && entry !== SCRUBBED_PAYLOAD) problems.push(`${fieldPath} is an unparsed payload`)

    if (/^(chip_id|tag_uid|tray_uuid)$/.test(key) && !/^0*$/.test(String(entry))) problems.push(`${fieldPath} is a hardware identifier`)

    if (/^(subtask_name|gcode_file)$/.test(key) && entry !== "" && entry !== SCRUBBED_JOB) problems.push(`${fieldPath} is a job name`)

    return problems
  })
}

const root = fileURLToPath(new URL("./fixtures/tapes", import.meta.url))

const tapeFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)

    return entry.isDirectory() ? tapeFiles(path) : entry.name.endsWith(".jsonl") ? [path] : []
  })

test("there is at least one committed tape to guard", () => {
  assert.ok(tapeFiles(root).length > 0)
})

for (const path of tapeFiles(root)) {
  test(`committed tape ${path.slice(root.length + 1)} holds only scrubbed identifiers`, () => {
    const violations = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line, index) => privacyViolations(JSON.parse(line), `line ${index + 1}`))

    assert.deepEqual(violations, [])
  })
}

test("the guard rejects every kind of unscrubbed identifier", () => {
  const fixtures: ReadonlyArray<Schema.JsonObject> = [
    { sn: "01PTEST000000001" },
    { serial_number: "01PTEST000000001" },
    { topic: "device/01PTEST000000001/report" },
    { net: { info: [{ ip: 1 }] } },
    { ip: "10.0.0.1" },
    { msg: "reached 192.168.001.010" },
    { msg: "reached 10.10.10.10" },
    { ip: "192.0.2.010" },
    { text: "aa:bb:cc:dd:ee:ff" },
    { mac_address: "aabbccddeeff" },
    { wifi_ssid: "test-network" },
    { hostname: "test-host" },
    { chip_id: "test-chip" },
    { tray: [{ tag_uid: "A1B2C3D4E5F60708" }] },
    { tray: [{ tray_uuid: "0123456789ABCDEF0123456789ABCDEF" }] },
    { device: { dev_id: "01PTEST000000001" } },
    { message: "AMS 006TEST000000009 offline" },
    { raw: "unparsed" },
    { print: { subtask_name: "CUSTOMER_PART_x3" } },
    { print: { task_id: "817264" } },
    { print: { project_id: 52814471 } },
    { dev_name: "Workshop printer" },
    { dev_product_name: "My P1S" },
    { user_id: "1234567" },
    { uid: "1234567" },
    { wifi_name: "test-network" },
    { ipcam: { rtsp_url: "rtsps://bblp:secret@printer.local:322/streaming/live/1" } },
    { msg: "stream at rtsps://bblp:secret@printer.local:322/live" },
    { msg: "reached fe80::1%eth0" },
    { msg: "reached [2a00:1450:4001:81b::200e]:8883" },
    { msg: "reached 2a00:1450:4001:081b:0000:0000:0000:200e" },
    { msg: "reached 10.01.00.05 over Wi-Fi" },
    { ip: "10.01.00.05" },
    { msg: "at fe80:<redacted>:de now" },
    { msg: "at <redacted>::1 now" }
  ]

  for (const [index, fixture] of fixtures.entries()) {
    assert.ok(privacyViolations(fixture).length > 0, `fixture ${index}`)
  }
})

test("the guard permits synthetic serials, empty fields, zero IPs, RFC 5737 addresses and firmware versions", () => {
  assert.deepEqual(
    privacyViolations({
      sn: "01PMOCK00000001",
      serial: "",
      ams_id: "0",
      chip_id: "00000000",
      tag_uid: "0000000000000000",
      tray_uuid: "00000000000000000000000000000000",
      hostname: "",
      net: { info: [{ ip: 0 }, { ip: "192.0.2.1" }, { ip: "198.51.100.2" }] },
      ip: "203.0.113.3",
      sw_ver: "01.09.00.01",
      loader_ver: "00.00.00.14",
      subtask_name: "scrubbed-job",
      gcode_file: "",
      task_id: "1",
      subtask_id: "0",
      project_id: 2,
      profile_id: "-1",
      dev_name: "",
      rtsp_url: "",
      msg: `see ${SCRUBBED_URL} at 2001:db8::1 or [2001:db8::1]:8883 at 12:30:45`
    }),
    []
  )
})
