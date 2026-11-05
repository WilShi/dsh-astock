/**
 * dsh-astock — A-share research tools for DeepSeek Harness.
 *
 * Registers six model-facing tools on `ctx.tools`. All upstream data comes from
 * public, key-free endpoints, so installing the plugin is the whole setup.
 */

import type { Context } from "@deepseek-ai/cordis";
import { astockTools } from "./tools.ts";

/** Plugin name used by the Cordis loader and `cordis.patch.yml`. */
export const name = "dsh-astock";

/** This plugin contributes tools only; the harness supplies the registry. */
export const inject = ["tools"];

/**
 * Register every A-share tool on the harness tool registry.
 *
 * Registration is an effect: disposing this plugin's fiber unregisters them.
 * @param ctx - the Cordis context supplied by the loader.
 */
export function apply(ctx: Context): void {
  for (const tool of astockTools) {
    ctx.tools.register(tool);
  }
}
