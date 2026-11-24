/**
 * Brand match — when the user's message names a saved brand ("a NutriShop
 * flyer", "the store's price list" with "the store" as an alias), every
 * Office file made for it is made in that brand. The user asked for brands
 * to be applied by code, not left to the model remembering them (2026-11-23):
 * a model handed a brand list forgets it often enough to matter, and a
 * company's document in the wrong colors is the failure the library exists
 * to prevent.
 *
 * Fills the `brand` argument only where the model left it out, so a model
 * that chose a brand (or "none") keeps its choice. Reads only a message the
 * user typed: a harness-composed task naming a brand is not the user asking
 * for it (isHarnessAuthoredTask). Mutating the call args is the established
 * middleware pattern (office-theme-guard.ts); the rewrite is counted with
 * recordGuardFire so the guard's activity is visible.
 */
import type { CanonicalMiddleware } from "./types.js";
import { isHarnessAuthoredTask } from "./types.js";
import { recordGuardFire } from "../turn-loop/guard-fire.js";
import { OFFICE_KIT } from "../../tools/tool-kits.js";
import { listBrands, type Brand } from "../../tools/shared/brand-store.js";

/** The tools that take a `brand`: the Office family and the chart renderer
 *  whose images go into those files. */
const BRANDED_TOOLS = new Set([...OFFICE_KIT, "create_chart"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The saved brand the message names first, by its name, slug or an alias,
 *  as whole words in any case. */
export function brandNamedIn(message: string, brands: Brand[]): Brand | null {
  let best: { brand: Brand; at: number } | null = null;
  for (const brand of brands) {
    for (const name of [brand.name, brand.slug, ...brand.aliases]) {
      if (name.trim().length < 2) continue;
      const words = name.trim().split(/[\s-]+/).map(escape).join("[\\s-]*");
      const at = message.search(new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "iu"));
      if (at >= 0 && (!best || at < best.at)) best = { brand, at };
    }
  }
  return best?.brand ?? null;
}

function hasBrand(args: unknown): boolean {
  return !!args && typeof args === "object" && "brand" in (args as Record<string, unknown>)
    && typeof (args as Record<string, unknown>).brand === "string" && ((args as Record<string, unknown>).brand as string).trim() !== "";
}

export const brandMatchMiddleware: CanonicalMiddleware = {
  name: "brand-match",

  afterModelCall(ctx) {
    if (!ctx.toolCalls.some((tc) => BRANDED_TOOLS.has(tc.tool))) return { kind: "continue" };
    if (isHarnessAuthoredTask(ctx)) return { kind: "continue" };
    let brands: Brand[];
    try { brands = listBrands(); } catch { return { kind: "continue" }; }
    const brand = brands.length ? brandNamedIn(ctx.currentUserMessage, brands) : null;
    if (!brand) return { kind: "continue" };
    let filled = false;
    for (const tc of ctx.toolCalls) {
      if (!BRANDED_TOOLS.has(tc.tool)) continue;
      if (typeof tc.args === "string") {
        try {
          const parsed = JSON.parse(tc.args) as Record<string, unknown>;
          if (!parsed || typeof parsed !== "object" || hasBrand(parsed)) continue;
          parsed.brand = brand.name;
          tc.args = JSON.stringify(parsed);
          filled = true;
        } catch { /* unparseable args fail in dispatch with a real error */ }
      } else if (tc.args && typeof tc.args === "object" && !hasBrand(tc.args)) {
        (tc.args as Record<string, unknown>).brand = brand.name;
        filled = true;
      }
    }
    if (filled) recordGuardFire(ctx.op.id, ctx.turnIdx, { name: "brand-match", reason: "brand-fill", outcome: "rewrite" });
    return { kind: "continue" };
  },
};
