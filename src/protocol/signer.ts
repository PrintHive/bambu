import { Context, Effect } from "effect"
import type { Encoded } from "./commands.ts"

/**
 * Signs a request before it is written. Firmware from January 2025 can require X.509-signed `print.*` commands;
 * Developer Mode keeps plain LAN access, and v1 targets Developer Mode. The default signs nothing, so a signed
 * transport can be added later without changing callers. Signing is provisional: see `@printhive/bambu/provisional`.
 */
export interface CommandSigner {
  readonly signs: boolean
  readonly sign: (encoded: Encoded) => Effect.Effect<Encoded>
}

export const CommandSigner = Context.Reference<CommandSigner>("@printhive/bambu/CommandSigner", {
  defaultValue: () => ({ signs: false, sign: Effect.succeed })
})
