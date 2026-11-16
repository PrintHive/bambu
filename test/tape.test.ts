import assert from "node:assert/strict"
import { formatTape, parseTape, type Tape } from "../src/tape/format.ts"
import { isFirmwareVersion, scrubTape, TapeScrubber } from "../src/tape/scrub.ts"

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

test("zero-padded addresses are scrubbed, firmware versions are kept", () => {
  for (const address of ["192.168.001.010", "010.000.000.005", "10.10.10.10", "192.168.1.20"]) {
    assert.deepEqual(new TapeScrubber().scrub({ msg: `host ${address}` }), { msg: "host 192.0.2.1" }, address)
  }

  for (const version of ["01.09.00.01", "00.00.00.00", "00.01.32.93"]) {
    assert.deepEqual(new TapeScrubber().scrub({ sw_ver: version }), { sw_ver: version }, version)
    assert.equal(isFirmwareVersion(version), true)
  }
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
