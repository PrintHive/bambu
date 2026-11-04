---
name: verify-wire-merge
description: Check report folding when changing src/wire/merge.ts, module identity, observedAt, AMS reset, atPath, or sourceAtPath.
---

# Verify wire merge

## Status

The real production baseline includes both malformed-body timestamp fixes from
commit `747768d94c106276b5f3cf016c496657136119f2` in PR #3. All four properties pass,
and all nine mutants are caught. PR #2 is stacked on PR #3 and merges after it.

## Property and harm

After each report, raw evidence follows the documented replacement and retention
rules. Every timed node has its last writer's observation time, and every
observedAt path resolves to retained raw evidence.

A wrong timestamp can attribute old printer evidence to a new report or leave
projection reading the wrong source time.

Object category roots are structural. The category object branch assigns `next`
without stamping the category; the non-object branch stamps the entire body.
The `print.ams` object branch assigns the merged container and stamps only
reported children. The timestamp oracle excludes
these structural containers, while requiring timestamps for non-object bodies
and all other descendants. A scalar or array reported at `print.ams` still
requires its own timestamp. The dangling-path property has no such exemptions.

## Tool and why

fast-check 4.10.2 is an exact-pinned devDependency with bun.lock.
It runs the actual TypeScript merge function. This is randomized bounded property
testing, not an exhaustive proof. TLA+ would check a hand copy rather than the
implementation at risk. The independent oracle stores time on tree nodes and
uses an insertion-ordered identity map for modules. It regenerates paths from
that tree and never imports stamp, forget, or the production reindex algorithm.

## Run it

From the repository root, run `bun install --frozen-lockfile`, then:

```sh
.agents/skills/verify-wire-merge/scripts/verify-wire-merge check
.agents/skills/verify-wire-merge/scripts/verify-wire-merge deep
.agents/skills/verify-wire-merge/scripts/verify-wire-merge mutants
.agents/skills/verify-wire-merge/scripts/verify-wire-merge drift
```

Plain `bun test` and `bun run test:node` run 50 cases per property. `check`
runs 300, and `deep` runs 20000. All default to seed 73129. Override with
`WIRE_MERGE_SEED`; direct test runs also accept `WIRE_MERGE_RUNS`.
The runner prints elapsed wall time.

`mutants` first runs baseline `check` at 300 cases. When that is red, it exits
nonzero with `REFUSED`, applies no mutants, and credits no kills. On a green
baseline it requires a counterexample for each break at the same 300-case bound.
It restores exact original bytes on errors and catchable interrupts. Do not edit
merge.ts during a mutation run. Each run takes a lock at
`$(git rev-parse --git-path verify-wire-merge.lock)` that holds the original
bytes. A second run refuses with `LOCKED`. If a run is killed before cleanup,
the lock stays behind. The next run refuses and prints how to restore merge.ts
from it. The validation table below uses the real committed baseline.

## Bounds and assumptions

Each case has 1 through 20 reports, starting from empty Evidence. Report times
are 1 through sequence length. Assertions run after every prefix.
Generated print and info reports mix malformed scalar/array category bodies,
shallow field replacements, AMS partial updates and resets, module arrays,
and envelope keys. Leaves include small integers, booleans, null, short invented
strings, arrays up to three elements and objects with x/y keys. Module arrays
have up to six entries with a three-name pool, omitted fields, nameless objects
and scalar entries. This creates identity collisions and index shifts.

Module behavior follows merge.ts comments and README. A named entry replaces
the entire previous entry, omitted named entries survive, and each array report
replaces the nameless set. AMS reset clears the entire old base and ignores
incoming units when ams_exist_bits is "0". Envelope keys are excluded only at
the immediate category level, not inside arbitrary nested data.

## Not covered

No network, MQTT ordering, decoding schemas, field projection correctness,
printer hardware, or emulator behavior is verified. Names are strings, not
arbitrary JSON module identities. Keys contain no dots or prototype names, so a dotted category such as
`"print.mc_percent"` that shares a path with a real reading is out of scope.
The example test in `test/wire-merge.test.ts` covers that case through `reduce`.
No arbitrary initial Evidence, repeated/non-finite times, deep recursion,
performance bound, or exhaustive input coverage is claimed. No printer captures,
serial-shaped strings, or real IP addresses are generated.

## Fixed findings

Both findings were fixed in commit `747768d94c106276b5f3cf016c496657136119f2` in PR #3.

### Category array replaced by an object retains deleted paths

1. Call `merge(empty, { print: [[]] }, 1)`.
2. Call `merge(previous, { print: { ams: { ams_exist_bits: "0", ams: [] } } }, 2)`.
3. Before the fix, `oldBody` is not an object, so `next` starts as `{}`.
   The old category times are never forgotten. `observedAt` still has
   `print.0` and `print` at time 1, although `raw.print` has no index 0.

Harm: observedAt retains a source time for a value that no longer exists.

Fix before writing keys: when `oldBody` exists and is not an object, forget only
the times under `category` that no longer resolve once the old body is removed.
Review added both conditions. An absent category has nothing to forget, and a
dotted category such as `"print.mc_percent"` shares its path with a real reading
whose time must survive. The example tests in `test/wire-merge.test.ts` cover
both dotted cases through `reduce`.
The fix now clears these times before writing keys.

### AMS array replaced by an object retains deleted paths

1. Call `merge(empty, { print: { ams: [0] } }, 1)`.
2. Call `merge(previous, { print: { ams: {} } }, 2)`.
3. Before the fix, `old` is not an object, so `base` starts as `{}`.
   With no reset or incoming children, nothing forgets `print.ams.0` at time 1,
   although `raw.print.ams` has no index 0.

Harm: observedAt retains an AMS source time for a value that no longer exists.

One-line fix inside the object AMS branch: `if (!isObject(old)) forget(path, observedAt)`.
The fix now clears these times before merging children. Removing this fix is
caught by its dedicated mutant.

## Read a failure

fast-check prints its seed, shrink path and Counterexample. The nested error
prints the report number and shortest failing prefix. Read those as calls
`merge(previous, report, now)` with now starting at 1. Shrinking may leave unused
later reports in Counterexample; the nested Steps stops at the actual failure.

Reproduce the printed sequence directly against merge before deciding whether
it is a code bug or an oracle/generator error. Compare raw and timestamps at
each step; inspect module comments and README. An oracle correction needs an
explanation from code, such as the structural-container rules above. Keep real
findings red; do not weaken the property or change src without authorization.

## Update for an intended change

Read changed code and reconcile its documented behavior with fold, generators
and assertions. Add report forms and realistic mutants for new behavior. Run
check, deep, mutants and both package suites. Follow this skill cold: establish
a green baseline, scratch-break merge.ts, confirm check prints a readable new
counterexample, restore original bytes, and confirm check returns to baseline.
Never credit baseline failures as mutant kills. Use /maintain-formal-verification-skill when covered
code changed without rechecking this verification.

## Coverage record

SYNC_COMMIT: `a140461b570d95ccd385d70d4cce0bbcee22cdfd` (PR #3 squash on main; same
covered code as its verified head `a1ff6a37a9e509a0b911dffdaadedf9a44072dd5`).

- src/wire/merge.ts: merge, stamp, forget, sourceAtPath, atPath.
- src/wire/report.ts: isObject boundary semantics, confirmed from source.
- src/state/project.ts: observationTime and malformed ancestor consumers,
  read for consequences, not directly exercised by the property.
- src/state/reduce.ts: merge callers, read for scope only.
- test/wire-merge.property.test.ts: generators, independent fold and assertions.

`drift` lists changes to these files since SYNC_COMMIT. It exits nonzero and
lists the files when any covered file has uncommitted changes, so commit or
revert them first. Move the sync commit
forward here and in the runner only after confirming that the model still
describes the new code. A sync record identifies reviewed source; it does
not imply that the recorded source passes the properties.

## Validation record

Measured on the real committed fix baseline, with four properties at seed 73129:
`check` passed at 300 cases per property in 0.19 seconds; `deep` passed at 20000
cases per property in 4.11 seconds. The timestamp property also rejects any
`observedAt` path the oracle does not time, so stamping a structural container fails. Mutants used that same baseline and bound,
with a passing 0.36-second preflight check.

| Break | Result at 300 cases | Elapsed |
| --- | --- | --- |
| Omit category shape cleanup | Caught | 0.21 s |
| Omit AMS shape cleanup | Caught | 0.40 s |
| Omit module subtree cleanup | Caught | 0.51 s |
| Match modules by index | Caught | 0.32 s |
| Merge module fields | Caught | 0.28 s |
| Skip retained-time reindex | Caught | 0.35 s |
| Keep AMS units on reset | Caught | 0.41 s |
| Stamp the structural AMS container | Caught | under 1 s |
| Store envelope keys | Caught | 0.42 s |

Cold scratch-break run on the real baseline: check passed in 0.32 seconds.
Disabling envelope exclusion with `if (false) continue` failed in 0.27 seconds,
with the one-report raw-evidence counterexample
`{ info: { module: [], command: false, sequence_id: 0 } }`.
Restoring exact original bytes returned check to green in 0.44 seconds.
`git diff --exit-code -- src/` was clean afterward.

`bun run check` passes lint, typechecking and all 41 Bun tests.
`bun run test:node` passes all 41 Node tests.
