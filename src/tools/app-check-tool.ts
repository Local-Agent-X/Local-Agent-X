/**
 * app_check: the chat's check of an app it built.
 *
 * The chat writes an app itself (build_app returns the brief, build-app.ts)
 * and calls this before it says done. The checks are the ones a worker's build
 * passed (canonical-loop's verifyBuiltApp): the app is loaded headlessly, its
 * main action is clicked, the screenshots are judged against the brief, and a
 * project's structure check is run. What they found comes back as the result,
 * with the app's link only when there is something to open.
 */
import { existsSync } from "node:fs";
import { workspacePath } from "../config.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { verifyBuiltApp, type AppVerifyGates, type AppVerifyOutcome } from "../canonical-loop/public/build-adapters.js";
import { onProgressOf, operationIdOf, sessionIdOf } from "../tool-execution/internal-args.js";
import { selfPort } from "../security/layer/loopback-grant.js";
import { readAppBuildBrief } from "./build-app.js";

const linkLine = (url: string): string =>
  `App URL: ${url} (include this URL verbatim in your reply to the user so it renders as a clickable link).`;

const shotsLine = (shots: Array<string | undefined> | undefined): string => {
  const paths = (shots ?? []).filter((p): p is string => typeof p === "string");
  return paths.length ? `\nScreenshots: ${paths.join(", ")} (view them before you change anything).` : "";
};

/** app_check's result for what the checks found. */
export function appCheckResult(appName: string, outcome: AppVerifyOutcome, lines: string[]): ToolResult {
  const url = (outcome.kind !== "failed" && outcome.url) || `http://127.0.0.1:${selfPort()}/apps/${appName}/index.html`;
  const log = lines.length ? `\n\n${lines.join("\n")}` : "";
  if (outcome.kind === "failed") {
    // The machine could not run the check: the app was not shown to be broken.
    if (outcome.code === "app_smoke_environment_failed") {
      return { content: `NOT CHECKED: this machine could not run the check, so the app was not shown to work or to be broken. ${outcome.detail}\n\nGive the user the link and say plainly that nothing opened the app to check it, and why.\n${linkLine(url)}${log}` };
    }
    return {
      content: `NOT READY (${outcome.code}). ${outcome.detail}${shotsLine(outcome.evidence)}\n\nFix it, then call app_check again. Do not give the user the link yet.${log}`,
      isError: true,
      metadata: { app: appName, check: "failed", code: outcome.code },
    };
  }
  if (outcome.kind === "unverified") {
    return {
      content: `NOT CHECKED: nothing opened the app on this machine. ${outcome.detail}\n\nGive the user the link and say plainly that the app was not opened or checked, and why.\n${linkLine(url)}${log}`,
      metadata: { app: appName, check: "unverified" },
    };
  }
  if (outcome.kind === "design-noted") {
    return {
      content: `The app runs clean. ${outcome.detail}\n\nIf the point is fair, improve the look once and call app_check again; otherwise give the user the link and tell them what the check noted.\n${linkLine(url)}${log}`,
      metadata: { app: appName, check: "design-noted" },
    };
  }
  const look = outcome.judge === "passed" ? "its look was judged to match the brief" : outcome.judge === "unavailable" ? "its look was not judged (no model that can read images is signed in)" : "its look was not judged";
  return {
    content: `APP READY: it loaded with no errors${outcome.interacted ? ", survived a click on its main action" : ""}, and ${look}.\n${linkLine(url)}${log}`,
    metadata: { app: appName, check: "verified" },
  };
}

/** `gates`: the checks' own test seams, so a test launches no browser or model. */
export function createAppCheckTool(gates?: AppVerifyGates): ToolDefinition {
  return {
    name: "app_check",
    compactDescription: "Check an app you built under workspace/apps/: loads it, clicks it, judges it against the brief. Returns what to fix, or the app's link.",
    description:
      "Check an app you built under workspace/apps/ before you tell the user it is done. It loads the app headlessly, clicks its main action, " +
      "has the screenshots judged against the build brief, and runs the project's structure check. The result is either what to fix (fix it and " +
      "call app_check again) or the app's link to give the user. Call it after build_app and your own writes; do not open the app in the browser tool to check it yourself.",
    describeCall: (args) => `Check app: ${String(args.name || "")}`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The app's folder name under workspace/apps/ (the name given to build_app)." },
      },
      required: ["name"],
    },
    async execute(args): Promise<ToolResult> {
      const appName = String(args.name || "").replace(/[^a-zA-Z0-9_-]/g, "-");
      const appDir = workspacePath("apps", appName);
      if (!appName || !existsSync(appDir)) {
        return { content: `No app named "${appName}" under workspace/apps/. Start one with build_app, or pass the folder name of the app you wrote.`, isError: true };
      }
      const brief = readAppBuildBrief(appDir);
      const lines: string[] = [];
      const progress = onProgressOf(args);
      const outcome = await verifyBuiltApp({
        appDir,
        tier: brief?.tier,
        brief: brief?.prompt ?? "",
        newBuild: brief?.newBuild ?? false,
        opId: operationIdOf(args) ?? `app-check-${appName}`,
        designSpec: brief?.designSpec,
        sessionId: sessionIdOf(args),
        gates,
        say: (line) => { lines.push(line); progress?.(line); },
      });
      return appCheckResult(appName, outcome, lines);
    },
  };
}

export const appCheckTool: ToolDefinition = createAppCheckTool();
