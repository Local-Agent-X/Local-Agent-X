import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FileNavigationResult, FileNavigationScenarioId } from "./types.js";

/**
 * file_navigation stage — can the model FIND and READ a file in a workspace?
 *
 * Live baseline this stage pins (2026-09-08, muse-glimmer:30b): the request
 * "check the footer for bellavidamassage clone" took 15 actions (2 failed) to
 * locate workspace/apps/bellavida-medical-massage-clone/index.html and then
 * overflowed the context window. Each scenario here is scored binary like its
 * siblings, but the scorecard also carries `actions` / `failedActions` per
 * scenario so a regression from 3 actions to 15 stays visible while the
 * scenario still passes.
 *
 * The fixture is three app directories with deliberately similar names; only
 * the target's footer carries FOOTER_MARKER and only the target's stylesheet
 * defines CSS_SYMBOL. Neither the markers nor the resolved paths appear in any
 * prompt, so a pass can only come from the model actually reading the files.
 */
export const FILE_NAVIGATION_SCENARIO_IDS = [
  "find_app_by_fuzzy_name",
  "read_file_section",
  "grep_for_symbol",
] as const;

export const FILE_NAVIGATION_MAX_ACTIONS = 12;
export const FILE_NAVIGATION_SCENARIO_TIMEOUT_MS = 3 * 60_000;

export const FILE_NAVIGATION_TARGET_APP = "bellavida-medical-massage-clone";
export const FILE_NAVIGATION_DECOY_APPS = ["bellavista-massage-clone", "bella-medical-spa-clone"] as const;
export const FOOTER_MARKER = "LAX_QUALIFICATION_FOOTER_3D9A";
const DECOY_FOOTER_MARKERS = ["LAX_QUALIFICATION_DECOY_51B0", "LAX_QUALIFICATION_DECOY_C7E4"] as const;
export const CSS_SYMBOL = "qualification-accent-9b17";
export const CSS_DEFINITION_PATH = `apps/${FILE_NAVIGATION_TARGET_APP}/css/site.css`;

function indexHtml(title: string, mainClass: string, footerMarker: string): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    `  <meta charset=\"utf-8\">`,
    `  <title>${title}</title>`,
    "  <link rel=\"stylesheet\" href=\"css/site.css\">",
    "</head>",
    "<body>",
    `  <header class=\"site-header\"><h1>${title}</h1></header>`,
    `  <main class=\"${mainClass}\">`,
    "    <p>Book a session with our licensed therapists. Walk-ins welcome.</p>",
    "  </main>",
    "  <footer class=\"site-footer\">",
    `    <p>&copy; ${title} &middot; ${footerMarker} &middot; 1200 Custer Rd, McKinney TX</p>`,
    "  </footer>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function siteCss(accentClass: string): string {
  return [
    ".site-header { padding: 1rem; }",
    ".site-footer { padding: 1rem; font-size: 0.875rem; }",
    `.${accentClass} { color: #0a6; }`,
    "",
  ].join("\n");
}

function writeApp(workspace: string, name: string, title: string, mainClass: string, footerMarker: string): void {
  const app = join(workspace, "apps", name);
  mkdirSync(join(app, "css"), { recursive: true });
  writeFileSync(join(app, "index.html"), indexHtml(title, mainClass, footerMarker), "utf8");
  writeFileSync(join(app, "css", "site.css"), siteCss(mainClass), "utf8");
}

/** Creates the throwaway fixture under an owned workspace directory. */
export function writeFileNavigationFixture(workspace: string): void {
  writeApp(workspace, FILE_NAVIGATION_TARGET_APP, "Bella Vida Medical Massage", CSS_SYMBOL, FOOTER_MARKER);
  writeApp(workspace, FILE_NAVIGATION_DECOY_APPS[0], "Bella Vista Massage", "decoy-accent-51b0", DECOY_FOOTER_MARKERS[0]);
  writeApp(workspace, FILE_NAVIGATION_DECOY_APPS[1], "Bella Medical Spa", "decoy-accent-c7e4", DECOY_FOOTER_MARKERS[1]);
}

export function fileNavigationPrompt(scenario: FileNavigationScenarioId): string {
  return {
    find_app_by_fuzzy_name:
      "Find the app directory for the bellavidamassage clone under workspace/apps. Reply with only its directory path, nothing else.",
    read_file_section:
      "Check the footer of the bellavidamassage clone's index.html under workspace/apps and reply with exactly the text the footer contains.",
    grep_for_symbol:
      `Which file under workspace/apps defines the CSS class ${CSS_SYMBOL}? Reply with only that file path.`,
  }[scenario];
}

function normalizePath(text: string): string {
  return text.replaceAll("\\", "/");
}

/** Binary score: the final assistant text names the right thing and none of the decoys. */
export function scoreFileNavigation(scenario: FileNavigationScenarioId, finalText: string): boolean {
  const text = normalizePath(finalText);
  switch (scenario) {
    case "find_app_by_fuzzy_name":
      return text.includes(FILE_NAVIGATION_TARGET_APP)
        && !FILE_NAVIGATION_DECOY_APPS.some((decoy) => text.includes(decoy));
    case "read_file_section":
      return text.includes(FOOTER_MARKER)
        && !DECOY_FOOTER_MARKERS.some((decoy) => text.includes(decoy));
    case "grep_for_symbol":
      return text.includes(CSS_DEFINITION_PATH);
  }
}

export interface FileNavigationProgress {
  actions: number;
  failedActions: number;
}

/**
 * Streaming observer for a navigation turn. `onEvent` returns true once the
 * action cap is exceeded so the caller can cancel the stream instead of
 * letting a wandering model run to the wall clock.
 */
export function trackFileNavigation(onProgress?: (progress: FileNavigationProgress) => void): {
  onEvent(event: Record<string, unknown>): boolean;
  readonly capped: boolean;
} {
  let actions = 0;
  let failedActions = 0;
  let capped = false;
  return {
    onEvent(event) {
      if (event.type === "tool_start") {
        actions += 1;
        if (actions > FILE_NAVIGATION_MAX_ACTIONS) capped = true;
        onProgress?.({ actions, failedActions });
      } else if (event.type === "tool_end") {
        if (event.allowed === false || (event.status !== undefined && event.status !== "ok")) failedActions += 1;
        onProgress?.({ actions, failedActions });
      }
      return capped;
    },
    get capped() { return capped; },
  };
}

export function fileNavigationEvidence(events: Array<Record<string, unknown>>, capped: boolean): FileNavigationResult {
  let progress: FileNavigationProgress = { actions: 0, failedActions: 0 };
  const tracker = trackFileNavigation((next) => { progress = next; });
  for (const event of events) tracker.onEvent(event);
  return {
    done: events.some((event) => event.type === "done"),
    errorEvents: events.filter((event) => event.type === "error").length,
    finalText: events.filter((event) => event.type === "stream" && typeof event.delta === "string")
      .map((event) => String(event.delta)).join(""),
    actions: progress.actions,
    failedActions: progress.failedActions,
    capped: capped || tracker.capped,
  };
}
