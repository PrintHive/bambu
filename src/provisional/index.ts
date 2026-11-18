import * as Fact from "../protocol/provenance.ts"

/** A fact that is never verified: the type has no `Verified` case, so it cannot be presented as one. */
export type Provisional = Fact.Unverified<"provisional">

const provisional = (ref: string): Provisional => Fact.inferred("provisional", ref)

/**
 * Features gated or provisional under proposal rule 10. None of them is in the ordinary `Command` vocabulary, and no
 * dialect or emulator profile may present them as verified. Hive can lint-ban this import.
 *
 * Each has no wire encoding here: no clean-room source documents one, so sending them waits for a tape.
 */
export const features = {
  vortek: provisional("proposal rule 10: Vortek is gated; no tape or permissive source documents its commands"),
  timelapseStorage: provisional("proposal rule 10: timelapse storage is provisional; no tape documents where or how it is set"),
  signedCommands: provisional("proposal rule 10 and Authorization: X.509-signed print commands are not supported in v1; CommandSigner signs nothing by default")
} as const

export type ProvisionalFeature = keyof typeof features
