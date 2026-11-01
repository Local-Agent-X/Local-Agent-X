/**
 * `project_kit`: land the structure kit in the session's project folder on
 * request. The kit goes in by itself wherever a project is created (build_app,
 * the scaffolds, the write that starts an app: new-app-folder.ts); this is
 * the route for a project that missed it — one started in the shell, one
 * that predates the kit — and the step the /new-project protocol's "copy the
 * tooling" section names. Idempotent: a file that exists is never overwritten
 * (app-scaffold/project-kit.ts).
 *
 * Confined to the session's project folder, or an app under workspace/apps/
 * named by `app`: the kit writes files itself, outside the file tools' gate,
 * so the only folders it may touch are the ones the session already builds in.
 */
import type { ToolDefinition } from "../../types.js";
import { sessionIdOf } from "../../workspace/paths.js";
import { applyProjectKit, STRUCTURE_CHECK_COMMAND } from "../../app-scaffold/project-kit.js";
import { detectProjectKind } from "../../app-scaffold/project-kind.js";
import { appIdOf, appRootForSession, describeAppRoot } from "./app-root.js";
import { ok, err } from "./shared.js";

export const projectKit: ToolDefinition = {
  name: "project_kit",
  effect: { class: "idempotent-mutation" },
  description:
    "Land the structure kit in this session's project folder (or an app under workspace/apps/ named by `app`): " +
    "AGENTS.md, ARCHITECTURE.md, docs/adr/0001, docs/history, the check scripts under scripts/ and the seal test, " +
    "plus the npm scripts when package.json exists. Never overwrites a file that exists, so it is safe to call on a project " +
    "that already has some of it. A project the write tool started already has the kit; call this for one that was started " +
    "another way, or when the /new-project protocol says to.",
  parameters: {
    type: "object",
    properties: {
      app: { type: "string", description: "The app's folder name under workspace/apps/. Omit when this session already has a project folder: that folder is the project." },
      source_root: { type: "string", description: "The folder the checks scan, relative to the project (e.g. 'src'). Default: what the project kind implies; '.' for a project with no project file yet." },
    },
  },
  async execute(args: Record<string, unknown>) {
    const app = String(args.app || "").trim() || undefined;
    if (app && /[\\/]|^\.\.?$/.test(app)) return err("app must be a folder name under workspace/apps/, with no slashes");
    const root = appRootForSession(app, sessionIdOf(args));
    if (!root) return err("Name the app: this session has no project folder yet, so pass its folder name under workspace/apps/.");
    const given = String(args.source_root || "").trim();
    if (given && (given.startsWith("..") || /^([a-z]:)?[\\/]/i.test(given))) return err("source_root must be a folder inside the project");
    const sourceRoot = given || (detectProjectKind(root).language === "unknown" ? "." : undefined);
    const result = applyProjectKit(root, { projectName: appIdOf(root), ...(sourceRoot ? { sourceRoot } : {}) });
    const where = describeAppRoot(root);
    const lines = [
      result.written.length > 0
        ? `Structure kit landed in ${where}/: ${result.written.join(", ")}.`
        : `${where}/ already has the whole kit; nothing written.`,
      result.skipped.length > 0 ? `Left as they were: ${result.skipped.join(", ")}.` : "",
      result.wiredNpmScripts ? "package.json gained check:structure, docs:map, deps and refs, and build runs the check first." : "",
      `AGENTS.md holds the rules for changing the project; \`${STRUCTURE_CHECK_COMMAND}\` runs its checks. Run it now, then before every done.`,
    ].filter(Boolean);
    return ok(lines.join("\n"));
  },
};
