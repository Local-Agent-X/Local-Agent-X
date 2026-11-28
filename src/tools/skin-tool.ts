/**
 * The agent's door into the skin library (skins/skin-store.ts): when the user
 * says "give me a Christmas theme with falling snow", the agent builds it
 * here and turns it on, and it shows in the chat window and sidebars at once.
 * The Settings page edits the same library (routes/skins.ts).
 */
import { basename } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { resolveAgentPath, sessionIdOf } from "../workspace/paths.js";
import { readValidatedFile } from "../security/layer/index.js";
import { applySettings } from "../settings-apply.js";
import { loadSettings } from "../settings.js";
import {
  SKIN_BUILTIN_EFFECTS, SKIN_COLOR_ROLES, SKIN_FITS, findSkin, listSkins, saveSkin, type Skin, type SkinInput,
} from "../skins/skin-store.js";
import { SKIN_BACKGROUND_EXT, clearSkinBackground, removeSkin, setSkinBackground, setSkinEffectCode } from "../skins/skin-files.js";

const ACTIONS = ["list", "get", "save", "set_background", "clear_background", "set_effect_code", "apply", "remove"] as const;

const activeSlug = (): string => String((loadSettings() as Record<string, unknown>).skin ?? "");

/** One skin as the agent reads it. */
export function describeSkin(s: Skin): string {
  const colors = SKIN_COLOR_ROLES.filter((r) => s.colors[r]).map((r) => `${r} #${s.colors[r]}`).join(", ");
  const fx = s.effect;
  return [
    `${s.name}${activeSlug() === s.slug ? " (on now)" : ""}`,
    `Colors: ${colors || "none (the chosen palette's colors are used)"}`,
    `Background: ${s.background ? `${s.background}, ${s.fit}, blur ${s.blur}px, dim ${s.dim}` : "none"}`,
    `App graphic (the agent figure behind the chat): ${s.graphic ?? !s.background ? "shown" : "hidden"}`,
    `Panels: ${Math.round(s.opacity * 100)}% solid`,
    `Moving layer: ${fx ? `${fx.kind} (density ${fx.density}, speed ${fx.speed}, size ${fx.size}${fx.reactive ? ", grows as context fills" : ""})` : "none"}`,
  ].join("\n");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Tool args can arrive as JSON strings. */
const objArg = (v: unknown): Record<string, unknown> | undefined => {
  if (isObj(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("{")) { try { const p = JSON.parse(v); return isObj(p) ? p : undefined; } catch { return undefined; } }
  return undefined;
};

/** The fields a save call sets. */
function inputOf(args: Record<string, unknown>): SkinInput {
  const input: SkinInput = {};
  if (typeof args.new_name === "string") input.name = args.new_name;
  else if (typeof args.name === "string") input.name = args.name;
  const colors = objArg(args.colors);
  if (colors) input.colors = colors as Skin["colors"];
  if (typeof args.fit === "string") input.fit = args.fit as Skin["fit"];
  for (const k of ["opacity", "blur", "dim"] as const) if (typeof args[k] === "number") input[k] = args[k] as number;
  if (typeof args.graphic === "boolean") input.graphic = args.graphic;
  if (args.effect === "none" || args.effect === null) input.effect = null;
  else { const effect = objArg(args.effect); if (effect) input.effect = effect as SkinInput["effect"]; }
  return input;
}

/** Turn a skin on (or the built-in look, for ""), here and in every open tab. */
async function turnOn(slug: string): Promise<void> {
  await applySettings({ skin: slug });
}

const done = (verb: string, s: Skin, extra = ""): ToolResult =>
  ok(`${verb}${extra}\n${describeSkin(s)}`, { skin: s.name });

async function run(args: Record<string, unknown>): Promise<ToolResult> {
  const action = String(args.action ?? "");
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (action === "list") {
    const skins = listSkins();
    if (!skins.length) return ok("No themes are saved yet. Make one with action \"save\".");
    return ok(skins.map(describeSkin).join("\n\n"), { skins: skins.map((s) => s.name) });
  }
  if (action === "apply" && (!name || name.toLowerCase() === "none")) {
    await turnOn("");
    return ok("The window is back to its built-in look.");
  }
  if (!name) return err(`action "${action}" needs the theme's name.`);
  if (action === "save") {
    const existing = findSkin(name);
    const skin = saveSkin(inputOf(args), existing?.slug);
    if (args.apply !== false) await turnOn(skin.slug);
    return done(existing ? "Updated theme:" : "Saved theme:", skin, args.apply !== false ? " (it is on now)" : "");
  }
  const skin = findSkin(name);
  if (!skin) return err(`No saved theme "${name}". Saved: ${listSkins().map((x) => x.name).join(", ") || "none"}.`);
  if (action === "get") return ok(describeSkin(skin));
  if (action === "apply") { await turnOn(skin.slug); return done("Turned on:", skin); }
  if (action === "set_background") {
    const path = resolveAgentPath(String(args.path ?? ""), sessionIdOf(args));
    return done("Background set:", await setSkinBackground(skin.slug, { name: basename(path), data: readValidatedFile(path) }));
  }
  if (action === "clear_background") return done("Background removed (it is in the trash):", await clearSkinBackground(skin.slug));
  if (action === "set_effect_code") return done("Effect code saved and set as this theme's moving layer:", setSkinEffectCode(skin.slug, String(args.code ?? "")));
  if (action === "remove") {
    const wasOn = activeSlug() === skin.slug;
    await removeSkin(skin.slug);
    if (wasOn) await turnOn("");
    return ok(`Removed the ${skin.name} theme. Its folder is in the trash, where the user can restore it.`);
  }
  return err(`Unknown action "${action}". One of: ${ACTIONS.join(", ")}.`);
}

/** Open windows repaint, as after a change made in Settings (routes/skins.ts).
 *  Best-effort: no socket in a test. */
async function broadcastSkinsChanged(): Promise<void> {
  try {
    const { broadcastAll } = await import("../chat-ws/index.js");
    broadcastAll({ type: "settings_changed", settings: { skins: true } });
  } catch { /* the change is saved either way */ }
}

export const skinTool: ToolDefinition = {
  name: "skin",
  description:
    "The look of this app's own window: the user's custom themes (\"skins\"). A theme has a background picture or video, colors, " +
    "see-through panels and a moving layer behind the chat and sidebars. Use it when the user asks to restyle, theme or decorate the app " +
    "(\"make it Christmassy\", \"put my photo behind the chat\", \"animated background\"). " +
    "Actions: list; get; save (create or change, and turn it on unless apply:false: colors {bg, surface, text, accent} as hex, " +
    `fit ${SKIN_FITS.join(" | ")}, opacity 0.15–1 (how solid the panels are; lower shows more background), blur 0–40, dim 0–0.9, ` +
    "graphic true | false (whether the app's own agent-figure graphic shows behind the chat; by default it is hidden once the theme has a background), " +
    `effect {kind: ${SKIN_BUILTIN_EFFECTS.join(" | ")}, density, speed, size (each 0.2–3, 1 = normal), reactive (true = grows as the chat's context fills)} or "none"); ` +
    `set_background (path to a ${SKIN_BACKGROUND_EXT.join("/")} file, up to 10 MB; make one with the image tool first if the user wants a generated picture); ` +
    "clear_background; apply (name, or \"none\" for the built-in look); remove. " +
    "set_effect_code (code) is for a moving layer none of the built-in ones covers: plain JavaScript that defines draw(ctx, s, dt), " +
    "and optionally init(s), called every frame on a cleared full-window 2D canvas. s = {w, h, t (seconds), context (0–1, how full the chat's context is), " +
    "busy (the agent is working), mode (\"light\" | \"dark\"), accent, text, bg (CSS colors), density, speed, size, reactive}; dt is seconds since the last frame. " +
    "It runs in a sandbox with no network, no DOM beyond its canvas and no access to the app, so draw only. Keep it light: it runs behind text the user is reading.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      name: { type: "string", description: "The theme's name (to create, or the theme to act on)." },
      new_name: { type: "string", description: "(save) Rename the theme." },
      colors: { type: "object", description: "(save) Hex colors: bg (behind everything), surface (panels), text, accent. Text needs bg or surface with it." },
      fit: { type: "string", enum: [...SKIN_FITS], description: "(save) How the background fills the window." },
      opacity: { type: "number", description: "(save) 0.15–1: how solid the panels are over the background." },
      blur: { type: "number", description: "(save) 0–40: background blur in px." },
      dim: { type: "number", description: "(save) 0–0.9: how far the background fades toward the base color, so text stays readable." },
      graphic: { type: "boolean", description: "(save) Show the app's own graphic (the agent figure and skyline) behind the chat, over the theme's background." },
      effect: { description: "(save) The moving layer: {kind, density, speed, size, reactive}, or \"none\"." },
      apply: { type: "boolean", description: "(save) false saves without turning it on." },
      path: { type: "string", description: "(set_background) The picture or video to copy in." },
      code: { type: "string", description: "(set_effect_code) JavaScript defining draw(ctx, s, dt)." },
    },
  },
  async execute(args) {
    try {
      const result = await run(args);
      if (!result.isError && !["list", "get"].includes(String(args.action))) await broadcastSkinsChanged();
      return result;
    }
    catch (e) { return err((e as Error).message); }
  },
};
