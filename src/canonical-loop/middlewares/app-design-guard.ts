/**
 * App design guard — the house design system reaches app UI files written
 * OUTSIDE the build_app op path.
 *
 * build_app injects the archetype brief + CRAFT + anti-patterns into every
 * build it drives (render-builder-prompt.ts:renderPerBuildContext). An agent
 * that skips the tool and writes index.html/styles.css straight into
 * workspace/apps/ with its edit tools gets NONE of it — no tokens, no craft
 * rules, no anti-patterns, and no design-verify score either (that gate keys
 * off a build op id). The result is a generic page and a silent hole: nothing
 * reports that the design system was skipped. Measured 2026-09-04 on a
 * hand-written site — system font stack, default blue, entity checkmarks for
 * icons, zero prefers-reduced-motion.
 *
 * The rules are NOT restated here — they are imported from design-brief.ts,
 * the one source of truth the build path also reads. Archetype selection
 * follows the build path's rule exactly: a brief on a CREATE only, because an
 * UPDATE's message is a change instruction and classifying it injects a
 * mismatched archetype. Create-vs-update is decided in afterModelCall, before
 * the write lands, by looking at whether the app directory already had files.
 *
 * Fires at most ONCE per op, on the first app UI file written, so the model
 * gets the system while it is still authoring the rest of the app rather than
 * after the whole thing is done. Sits after post-edit-diagnostics in the
 * stack: a compile error the edit introduced outranks design polish.
 *
 * Disable with LAX_APP_DESIGN_GUARD=0.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CanonicalLoopContext, CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { isDispatchFailure } from "../types.js";
import { EDIT_TOOLS } from "../../agent-guards/verify-gate.js";
import { resolveAgentPath } from "../../workspace/paths.js";
import { workspacePath } from "../../config.js";
import { selectDesignBrief, DESIGN_CRAFT, DESIGN_ANTI_PATTERNS } from "../../tools/design-brief.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.app-design-guard");

/** Files whose content IS the visual design. A .md/.json/.ts write into an app
 *  carries no look, so it must not burn the op's single nudge. */
const DESIGN_EXT_RE = /\.(html?|css|jsx|tsx|vue|svelte)$/i;

/** Cap on apps tracked per op — a backstop, not a real limit. */
const MAX_TRACKED_APPS = 50;

interface AppDesignState {
  /** app id → true when the app directory was empty/absent before this op's
   *  first write to it (a CREATE, which earns the archetype brief). */
  creates: Map<string, boolean>;
  /** The op has already been given the design system; never nudge twice. */
  nudged: boolean;
}

function createAppDesignState(): AppDesignState {
  return { creates: new Map(), nudged: false };
}

/** Forward slashes for comparison; trailing separators and case differences on
 *  Windows must not defeat the prefix test. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * The app directory name a path lives under, or null when the path is not an
 * app file. A file written directly into apps/ (with no app directory of its
 * own) is not an app.
 */
export function appIdForPath(resolved: string, appsRoot: string): string | null {
  const root = norm(appsRoot);
  const path = norm(resolved);
  if (!path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  const rest = path.slice(root.length + 1);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

/** Resolved paths of app UI files this turn's edit-family calls target.
 *  `onlySucceeded` filters by dispatch status — unknown before dispatch
 *  (afterModelCall), known after it. */
function appUiPaths(ctx: CanonicalLoopContext, onlySucceeded: boolean): string[] {
  const statusById = new Map(ctx.toolResults.map((tr) => [tr.toolCallId, tr.status]));
  const out: string[] = [];
  for (const tc of ctx.toolCalls) {
    if (!EDIT_TOOLS.has(tc.tool)) continue;
    if (onlySucceeded) {
      const status = statusById.get(tc.toolCallId);
      if (isDispatchFailure(status) || status === "cancelled") continue;
    }
    const args = (tc.args ?? {}) as Record<string, unknown>;
    const raw =
      typeof args.file_path === "string" ? args.file_path
      : typeof args.path === "string" ? args.path
      : undefined;
    if (!raw || !DESIGN_EXT_RE.test(raw)) continue;
    const resolved = resolveAgentPath(raw);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/** True when the directory holds no files yet — the write about to land is
 *  creating this app, not updating it. A missing directory counts as empty. */
function looksLikeCreate(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function formatInjection(brief: string | null): string {
  return [
    "You wrote app UI files straight into workspace/apps/ instead of going through build_app, " +
      "so the house design system was never applied to them. It is not optional — revise the " +
      "files you just wrote to conform to it before writing more of this app or reporting done.",
    ...(brief ? [brief] : []),
    DESIGN_CRAFT,
    DESIGN_ANTI_PATTERNS,
  ].join("\n\n");
}

export const appDesignGuardMiddleware: CanonicalMiddleware = {
  name: "app-design-guard",

  // Before dispatch: the only moment the app directory's PRE-write contents
  // are observable, which is what separates a create from an update.
  afterModelCall(ctx) {
    if (process.env.LAX_APP_DESIGN_GUARD === "0") return { kind: "continue" };
    if (ctx.op.type === "build_app") return { kind: "continue" };
    try {
      const appsRoot = workspacePath("apps");
      const state = getMiddlewareState<AppDesignState>(
        ctx.op.id, "app-design-guard", createAppDesignState,
      );
      for (const path of appUiPaths(ctx, false)) {
        const appId = appIdForPath(path, appsRoot);
        if (!appId || state.creates.has(appId)) continue;
        if (state.creates.size >= MAX_TRACKED_APPS) break;
        state.creates.set(appId, looksLikeCreate(dirname(path)));
      }
    } catch (err) {
      logger.warn(
        `fail-open: create detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { kind: "continue" };
  },

  afterToolExecution(ctx) {
    if (process.env.LAX_APP_DESIGN_GUARD === "0") return { kind: "continue" };
    if (ctx.op.type === "build_app") return { kind: "continue" };
    try {
      const appsRoot = workspacePath("apps");
      const state = getMiddlewareState<AppDesignState>(
        ctx.op.id, "app-design-guard", createAppDesignState,
      );
      if (state.nudged) return { kind: "continue" };

      const appId = appUiPaths(ctx, true)
        .map((p) => appIdForPath(p, appsRoot))
        .find((id): id is string => id !== null);
      if (!appId) return { kind: "continue" };

      state.nudged = true;
      // An unrecorded app means afterModelCall never saw the write (args in a
      // shape it couldn't read). Treat it as an update: the craft rules and
      // anti-patterns still apply, and a guessed archetype is worse than none.
      const isCreate = state.creates.get(appId) === true;
      return {
        kind: "nudge",
        reason: "app-design-guard",
        message: formatInjection(isCreate ? selectDesignBrief(ctx.userMessage).brief : null),
      };
    } catch (err) {
      logger.warn(
        `fail-open: design injection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: "continue" };
    }
  },
};
