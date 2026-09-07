/**
 * Layout diagnostics — the `layout_report` action.
 *
 * Returns the compact JSON string produced by browser/layout-report.ts under
 * one preamble line that names the page and nothing else. The handler adds
 * no summary, no flags sentence and no emulation profile: the JSON's
 * `viewport` block is what the page measured, and a profile recorded for the
 * session is not evidence of what the current context runs (the context can
 * be re-minted by `navigate engine=`, or the profile set after it was minted).
 *
 * What layout-report.test.ts proves: the preamble is exactly
 * "Layout report for <url>." with a profile installed or not, the same bytes
 * for a clean and a truncated report; the JSON passes through unchanged
 * inside the untrusted-content wrapper; the constant clears the evaluate
 * blocklist and the handler refuses if it ever stops clearing it; one
 * evaluate call and no mutating backend method.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/backend.js";
import { LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
import { err } from "./shared.js";

export function layoutReportPreamble(url: string): string {
  return url ? `Layout report for ${url}.` : "Layout report for the current page.";
}

// The dispatcher (index.ts) hands each action the session id; this handler
// keys nothing on it (see the header: no per-session profile is printed).
export async function handleLayoutReport(manager: BrowserBackend, _sessionId?: string): Promise<ToolResult> {
  const url = manager.getCurrentUrl();
  const sensitive = sensitivePageStub(url);
  if (sensitive) {
    return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  }
  // Deliberate internal call: LAYOUT_REPORT_SCRIPT is a fixed constant, not
  // agent input, so the `evaluate` mutation heuristic (which judges UNTRUSTED
  // script text) is not applied to it.
  //
  // The blocklist is not inherited from the backend. Only the in-app backend
  // (ElectronInAppBackend.evaluate) scans internally; BrowserManager.evaluate,
  // the external-Chrome path, hands the text straight to the page. This
  // handler runs on whichever backend the session has, so the scan runs HERE,
  // before evaluate, on the path both backends share. The constant clears it
  // (pinned in layout-report.test.ts); this arm fires only if the script is
  // ever edited into something the blocklist rejects, and refuses rather than
  // relaxing the blocklist for it.
  const blocked = scanEvaluateScript(LAYOUT_REPORT_SCRIPT);
  if (blocked) {
    return err(
      "layout_report did not run: its own diagnostic script was rejected by the evaluate blocklist " +
      `(pattern ${blocked}). That is a bug in the script, not in the page - report it rather than working around it.`,
    );
  }
  // The script returns a compact JSON STRING sized under page-ops' evaluate
  // truncation (LAYOUT_REPORT_MAX_CHARS); evaluateScript passes a string
  // through as-is instead of pretty-printing it.
  const raw = await manager.evaluate(LAYOUT_REPORT_SCRIPT);
  return {
    content: `${layoutReportPreamble(url)}\n\n${wrapExternalContent(raw, "browser.layout_report")}`,
    metadata: { browserStatus: "layout-report" },
  };
}
