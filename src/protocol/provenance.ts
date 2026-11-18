import { Data, Predicate } from "effect"

/**
 * Where a protocol fact comes from, in the clean-room tiers of the design:
 *
 * - `tape`: a PrintHive capture of a real printer, scrubbed and committed under `test/fixtures/tapes`.
 * - `vendor-doc`: documentation Bambu Lab publishes.
 * - `community-mit`: a permissively licensed community source, such as pybambu's mock data.
 * - `community-copyleft-crosscheck`: a copyleft source one person read to cross-check a fact another person wrote.
 * - `inferred`: everything else, including the design's rule list, factual-tier docs such as OpenBambuAPI, and
 *   reasoned defaults.
 */
export type Provenance = "tape" | "vendor-doc" | "community-mit" | "community-copyleft-crosscheck" | "inferred"

/**
 * A fact with its source. Only a `tape` fact is `Verified`. Every other source is `Unverified` in the type, so code
 * that needs a verified fact has to match on the tag, and emulator output can say UNVERIFIED without a lookup.
 */
export type Fact<A> = Data.TaggedEnum<{
  Verified: { readonly value: A; readonly source: "tape"; readonly ref: string }
  Unverified: { readonly value: A; readonly source: Exclude<Provenance, "tape">; readonly ref: string }
}>

interface FactDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Fact<this["A"]>
}

const constructors = Data.taggedEnum<FactDefinition>()

export type Verified<A> = Extract<Fact<A>, { readonly _tag: "Verified" }>

export type Unverified<A> = Extract<Fact<A>, { readonly _tag: "Unverified" }>

export const match = constructors.$match

/** A fact read from a committed tape. `ref` names the tape and the frame. */
export const tape = <A>(value: A, ref: string): Verified<A> => constructors.Verified({ value, source: "tape", ref })

export const vendorDoc = <A>(value: A, ref: string): Unverified<A> => constructors.Unverified({ value, source: "vendor-doc", ref })

export const communityMit = <A>(value: A, ref: string): Unverified<A> => constructors.Unverified({ value, source: "community-mit", ref })

export const copyleftCrosscheck = <A>(value: A, ref: string): Unverified<A> =>
  constructors.Unverified({ value, source: "community-copyleft-crosscheck", ref })

export const inferred = <A>(value: A, ref: string): Unverified<A> => constructors.Unverified({ value, source: "inferred", ref })

export const isVerified = <A>(fact: Fact<A>): fact is Verified<A> => Predicate.isTagged(fact, "Verified")

/** `VERIFIED (tape: ref)` or `UNVERIFIED (inferred: ref)`, the label emulator output and reports use. */
export const label = <A>(fact: Fact<A>): string => `${isVerified(fact) ? "VERIFIED" : "UNVERIFIED"} (${fact.source}: ${fact.ref})`
