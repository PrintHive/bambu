---
name: verify-wire-merge
description: Check report folding when changing src/wire/merge.ts, module identity, observedAt, AMS reset, atPath, or sourceAtPath.
---

# Verify wire merge

## Status

This skill has two production findings. The strict dangling-path property stays
red until the owner fixes them. `bun test` and `bun run test:node` smoke runs,
`bun run check`, and CI are red on purpose until then. No production fix is
included. Validation against an uncommitted scratch baseline is recorded below.

## Property and harm

After each report, raw evidence follows the documented replacement and retention
rules. Every timed node has its last writer's observation time, and every
observedAt path resolves to retained raw evidence.

A wrong timestamp can attribute old printer evidence to a new report or leave
projection reading the wrong source time.

Object category roots are structural. `src/wire/merge.ts:107` assigns `next`
without stamping the category; lines 31-35 stamp non-object category bodies.
The `print.ams` object branch assigns the merged container at line 57 and
stamps only reported children at lines 59-64. The timestamp oracle excludes
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
merge.ts concurrently with a mutation run. Uncatchable termination cannot run
cleanup; inspect `git diff -- src/wire/merge.ts` afterward. The current unfixed
checkout must refuse; the table below uses an explicitly patched scratch baseline.

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
arbitrary JSON module identities. Keys contain no dots or prototype names.
No arbitrary initial Evidence, repeated/non-finite times, deep recursion,
performance bound, or exhaustive input coverage is claimed. No printer captures,
serial-shaped strings, or real IP addresses are generated.

## Findings

### Category array replaced by an object retains deleted paths

1. Call `merge(empty, { print: [[]] }, 1)`.
2. Call `merge(previous, { print: { ams: { ams_exist_bits: "0", ams: [] } } }, 2)`.
3. At merge.ts:39, `oldBody` is not an object, so `next` starts as `{}`.
   The old category times are never forgotten. `observedAt` still has
   `print.0` and `print` at time 1, although `raw.print` has no index 0.

Harm: observedAt retains a source time for a value that no longer exists.

One-line fix before writing keys: `if (!isObject(oldBody)) forget(category, observedAt)`.
The strict property stays red until this owner-owned fix lands.

### AMS array replaced by an object retains deleted paths

1. Call `merge(empty, { print: { ams: [0] } }, 1)`.
2. Call `merge(previous, { print: { ams: {} } }, 2)`.
3. At merge.ts:49, `old` is not an object, so `base` starts as `{}`.
   With no reset or incoming children, nothing forgets `print.ams.0` at time 1,
   although `raw.print.ams` has no index 0.

Harm: observedAt retains an AMS source time for a value that no longer exists.

One-line fix inside the object AMS branch: `if (!isObject(old)) forget(path, observedAt)`.
The strict property stays red until this owner-owned fix lands too. The first
scratch fix alone still fails at case 179 of 300 on this second finding.

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
If production has findings, use only an explicitly authorized scratch fix for
sensitivity checks and restore production afterward. Never credit baseline
failures as mutant kills. Use /maintain-formal-verification-skill when covered
code changed without rechecking this verification.

## Coverage record

Sync commit: `8fea2c254b9c0f738fec0401d1b766f08435487b` (bambu#1 squash).
Line citations above refer to this unchanged source.

- src/wire/merge.ts: merge, stamp, forget, sourceAtPath, atPath.
- src/wire/report.ts: isObject boundary semantics, confirmed from source.
- src/state/project.ts: observationTime and malformed ancestor consumers,
  read for consequences, not directly exercised by the property.
- src/state/reduce.ts: merge callers, read for scope only.
- test/wire-merge.property.test.ts: generators, independent fold and assertions.

`drift` lists changes to these files since SYNC_COMMIT. Move the sync commit
forward here and in the runner only after confirming that the model still
describes the new code. A sync record identifies reviewed source; it does
not imply that the recorded source passes the properties.

## Validation record

Measured against both one-line fixes above applied only in the working tree,
never committed: `check` passed in 0.81 seconds and `deep` in 38.57 seconds.
Each ran four properties at seed 73129, at 300 and 20000 cases per property.
Mutants used that same patched baseline, whose preflight check also passed.

| Break | Result at 300 cases | Elapsed |
| --- | --- | --- |
| Omit module subtree cleanup | Caught | 1.47 s |
| Match modules by index | Caught | 2.18 s |
| Merge module fields | Caught | 2.06 s |
| Skip retained-time reindex | Caught | 1.90 s |
| Keep AMS units on reset | Caught | 2.41 s |
| Store envelope keys | Caught | 1.31 s |

The cold run restored production first, reapplied only both scratch fixes,
confirmed check green, then disabled envelope exclusion with `if (false) continue`.
Check failed on a new raw-evidence counterexample with one report:
`{ info: { module: [], command: false, sequence_id: 0 } }`.
Restoring envelope exclusion returned check to green. Restoring the original
source returned check to the known dangling-path finding. `git diff --exit-code
src/` was clean. An unfixed `mutants` run refused before applying mutations.

Lint and typechecking pass. Bun and Node smoke suites each report 38 passing
tests and one failing strict dangling-path property on unchanged production.
The skill is sensitivity-validated against the scratch fixes, not a claim that
production satisfies its invariants.
