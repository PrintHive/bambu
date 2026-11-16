import assert from "node:assert/strict"
import { formatTape, parseTape, type Tape } from "../src/tape/format.ts"
import { scrubTape, TapeScrubber } from "../src/tape/scrub.ts"

const test: (name: string, run: () => void) => void = process.versions.bun ? (await import("node:test")).test : (await import("vitest")).test

const header = { header: true, family: "bambu", model: "P1S", firmware: "01.09.00.00", capturedAt: "" } as const
const serial = "01PTEST000000001"

test("scrubbing keeps serial pairing, module identity and payload structure", () => {
  const tape: Tape = {
    header,
    frames: [
      { t: 0, dir: "tx", topic: `device/${serial}/request`, frame: { sn: serial } },
      {
        t: 1,
        dir: "rx",
        topic: `device/${serial}/report`,
        frame: {
          info: { module: [{ sn: serial }, { sn: "006TEST000000001" }, { sn: "006TEST000000002" }] },
          print: {
            command: "push_status",
            net: { info: [{ ip: 1, mask: 1 }] },
            ssid: "test-network",
            hostname: "test-host",
            mac: "aa:bb:cc:dd:ee:ff",
            access_code: "test-code",
            ams: { ams: [{ ams_id: "006TEST000000001", chip_id: "test-chip" }] },
            ip_address: "10.0.0.1",
            message: "device/01PTEST000000001/report at 10.0.0.1 aa:bb:cc:dd:ee:ff"
          }
        }
      },
      { t: 2, dir: "rx", topic: `device/${serial}/report`, raw: "test-host" }
    ]
  }

  const scrubbed = scrubTape(tape)

  assert.deepEqual(scrubbed.frames, [
    { t: 0, dir: "tx", topic: "device/01PMOCK00000001/request", frame: { sn: "01PMOCK00000001" } },
    {
      t: 1,
      dir: "rx",
      topic: "device/01PMOCK00000001/report",
      frame: {
        info: { module: [{ sn: "01PMOCK00000001" }, { sn: "006MOCK00000002" }, { sn: "006MOCK00000003" }] },
        print: {
          command: "push_status",
          net: { info: [{ ip: 0, mask: 0 }] },
          ssid: "",
          hostname: "",
          mac: "",
          access_code: "",
          ams: { ams: [{ ams_id: "006MOCK00000002", chip_id: "000000000" }] },
          ip_address: "192.0.2.1",
          message: "device/01PMOCK00000001/report at 192.0.2.1 <redacted>"
        }
      }
    },
    { t: 2, dir: "rx", topic: "device/01PMOCK00000001/report", raw: "[scrubbed unparsed payload]" }
  ])
  assert.equal(formatTape(scrubbed).includes(serial), false)
})

test("scrubbing is deterministic and idempotent", () => {
  const tape: Tape = { header, frames: [{ t: 0, dir: "tx", topic: `device/${serial}/request`, frame: { sn: serial, msg: "at 192.168.1.20" } }] }
  const once = formatTape(scrubTape(tape))

  assert.equal(formatTape(scrubTape(tape)), once)
  assert.equal(formatTape(scrubTape(parseTape(once))), once)
})

test("every dotted address is scrubbed in text, and versions survive only in version fields", () => {
  for (const address of ["192.168.001.010", "010.000.000.005", "10.10.10.10", "192.168.1.20", "10.01.00.05"]) {
    assert.deepEqual(new TapeScrubber().scrub({ msg: `host ${address}` }), { msg: "host 192.0.2.1" }, address)
    assert.deepEqual(new TapeScrubber().scrub({ ip: address }), { ip: "192.0.2.1" }, address)
  }

  for (const [key, version] of [["sw_ver", "01.09.00.01"], ["loader_ver", "00.00.00.14"], ["firmware", "01.09.00.00"], ["hw_ver", "00.00.00.00"]] as const) {
    assert.deepEqual(new TapeScrubber().scrub({ [key]: version }), { [key]: version }, key)
  }

  // A version field holding something other than a version is scrubbed like any text.
  assert.deepEqual(new TapeScrubber().scrub({ sw_ver: "from 192.168.1.20" }), { sw_ver: "from 192.0.2.1" })
})

test("IPv6 addresses are replaced with the documentation address", () => {
  for (const address of ["fe80::1%eth0", "[2a00:1450:4001:81b::200e]", "2a00:1450:4001:081b:0000:0000:0000:200e", "::1"]) {
    for (const text of [`at ${address}`, `at ${address}:8883`]) {
      // The port may be kept or scrubbed with the address; the address itself never survives.
      assert.match(JSON.stringify(new TapeScrubber().scrub({ msg: text })), /^\{"msg":"at 2001:db8::1(:8883)?"\}$/, text)
    }
  }

  // Times and MAC-like values are not IPv6.
  assert.deepEqual(new TapeScrubber().scrub({ msg: "at 12:30:45" }), { msg: "at 12:30:45" })
})

test("URLs, device and user names, and Wi-Fi names are removed", () => {
  assert.deepEqual(
    new TapeScrubber().scrub({
      ipcam: { rtsp_url: "rtsps://bblp:secret@printer.local:322/streaming/live/1" },
      msg: "stream at rtsps://bblp:secret@printer.local:322/live now",
      dev_name: "Workshop printer",
      dev_product_name: "My P1S",
      user_id: "1234567",
      uid: 1234567,
      wifi_name: "test-network"
    }),
    { ipcam: { rtsp_url: "" }, msg: "stream at <redacted-url> now", dev_name: "", dev_product_name: "", user_id: "", uid: "", wifi_name: "" }
  )
})

test("cloud task ids become small synthetic ids of the same type, consistently across a tape", () => {
  const scrubber = new TapeScrubber()

  assert.deepEqual(scrubber.scrub({ print: { task_id: "817264", subtask_id: "0", project_id: 52814471, profile_id: "-1" } }), {
    print: { task_id: "1", subtask_id: "0", project_id: 2, profile_id: "-1" }
  })
  assert.deepEqual(scrubber.scrub({ print: { task_id: "817264" } }), { print: { task_id: "1" } })
})

test("job names are replaced, and an empty one stays empty", () => {
  assert.deepEqual(new TapeScrubber().scrub({ print: { subtask_name: "CUSTOMER_PART_x3", gcode_file: "/data/job.3mf" } }), {
    print: { subtask_name: "scrubbed-job", gcode_file: "scrubbed-job" }
  })
  assert.deepEqual(new TapeScrubber().scrub({ print: { subtask_name: "", gcode_file: "" } }), { print: { subtask_name: "", gcode_file: "" } })
})

test("numeric AMS selectors survive, so replayed commands still target the same unit", () => {
  const scrubber = new TapeScrubber()

  // 255 selects the external spool; small numbers select AMS units.
  assert.deepEqual(scrubber.scrub({ print: { command: "ams_filament_setting", ams_id: 255, tray_id: 254 } }), {
    print: { command: "ams_filament_setting", ams_id: 255, tray_id: 254 }
  })
  assert.deepEqual(scrubber.scrub({ print: { ams_id: "128" } }), { print: { ams_id: "128" } })
  assert.deepEqual(scrubber.scrub({ ams_id: "006TEST000000001" }), { ams_id: "006MOCK00000001" })
})

test("RFID identifiers are zeroed, and dev_id and free-text serials are scrubbed", () => {
  assert.deepEqual(new TapeScrubber().scrub({ tray: [{ tag_uid: "A1B2C3D4E5F60708", tray_uuid: "0123456789ABCDEF0123456789ABCDEF" }] }), {
    tray: [{ tag_uid: "0000000000000000", tray_uuid: "00000000000000000000000000000000" }]
  })
  assert.deepEqual(new TapeScrubber().scrub({ device: { dev_id: serial } }), { device: { dev_id: "01PMOCK00000001" } })
  // The serial appears in a message before any sn field names it.
  assert.deepEqual(new TapeScrubber().scrub({ print: { message: "AMS 006TEST000000009 offline" } }), {
    print: { message: "AMS 006MOCK00000001 offline" }
  })
})

test("known serials are replaced only as whole tokens, so short values leave other text alone", () => {
  const scrubber = new TapeScrubber()

  assert.deepEqual(scrubber.scrub({ sn: "1" }), { sn: "XXXMOCK00000001" })
  assert.deepEqual(scrubber.scrub({ message: "tray 1 at 21% firmware 01.09" }), { message: "tray 1 at 21% firmware 01.09" })
})

test("a malformed tape line is rejected with its line number", () => {
  assert.throws(() => parseTape(""), /header line/)
  assert.throws(() => parseTape(`${JSON.stringify(header)}\n{"t":0}\n`), /line 2/)
  assert.throws(() => parseTape(`${JSON.stringify(header)}\n\nnot json\n`), /line 3/)
})
