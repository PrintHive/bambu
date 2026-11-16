// Scrubs a captured tape before it is committed: bun scripts/scrub-tape.ts <input.jsonl> <output.jsonl>
// The output may be the input. It is written to a temporary file and renamed, so a failure leaves no
// partial tape. Scrubbing is deterministic and idempotent.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { formatTape, parseTape } from "../src/tape/format.ts"
import { scrubTape } from "../src/tape/scrub.ts"

const [input, output] = process.argv.slice(2)

if (input === undefined || output === undefined) {
  console.error("usage: bun scripts/scrub-tape.ts <input.jsonl> <output.jsonl>")
  process.exit(2)
}

const scrubbed = formatTape(scrubTape(parseTape(readFileSync(input, "utf8"))))
const temporary = `${output}.${process.pid}.tmp`

try {
  writeFileSync(temporary, scrubbed, { flag: "wx" })
  renameSync(temporary, output)
} catch (error) {
  rmSync(temporary, { force: true })
  throw error
}
