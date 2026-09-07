/**
 * Layout diagnostics — the `layout_report` action.
 *
 * Returns the RAW JSON produced by browser/layout-report.ts under one neutral
 * preamble line. It states no verdict: no "overflow: none", no "N elements",
 * no "N matching queries". Three prior rounds of this tool put a summary
 * sentence over the data and each round's sentence was false for some
 * partially-complete report (see the revert 55cea840); the JSON and its
 * completeness flags held up every time. So the model reads the data, and the
 * only sentence this handler adds is the one that is true of every report:
 * where a flag is set, the count it covers is a lower bound.
 *
 * Pairs with `emulate` (emulate.ts): a site that serves phones a different
 * document renders clean at 1280x800 forever.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/backend.js";
import { resolveBrowserSessionId } from "../../browser/session-owner-registry.js";
import { describeEmulation, getSessionEmulation } from "../../browser/emulation.js";
import { LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
import { err } from "./shared.js";

/** The one sentence added over the JSON. It is true of every report the
 *  script can produce, complete or truncated, because it asserts nothing
 *  about the page — only how to read the flags. */
export const LAYOUT_REPORT_FLAGS_SENTENCE =
  "Completeness flags are in the JSON; wherever a flag is set, the corresponding counts are lower bounds, not totals.";

/** URL, the emulation profile installed on the browser this session drives
 *  (a subagent drives its parent chat's browser, so the profile is looked up
 *  by the RESOLVED owner id, the same key the context runtime reads), and the
 *  flags sentence. The profile is what `emulate` recorded; the JSON's
 *  `viewport` block is what the page actually measured, and the two are
 *  printed side by side rather than reconciled here. */
export function layoutReportPreamble(url: string, sessionId: string): string {
  const where = url ? `Layout report for ${url}.` : "Layout report for the current page.";
  const profile = getSessionEmulation(resolveBrowserSessionId(sessionId || "default"));
  const emulated = profile
    ? ` Emulation profile installed on this session's browser: ${describeEmulation(profile).replace(/\n/g, "; ")}.`
    : "";
  return `${where}${emulated} ${LAYOUT_REPORT_FLAGS_SENTENCE}`;
}

export async function handleLayoutReport(manager: BrowserBackend, sessionId: string): Promise<ToolResult> {
  const url = manager.getCurrentUrl();
  const sensitive = sensitivePageStub(url);
  if (sensitive) {
    return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  }
  // Deliberate internal call: LAYOUT_REPORT_SCRIPT is a fixed, read-only
  // constant, not agent input, so the `evaluate` mutation heuristic (which
  // judges UNTRUSTED script text) is not applied to it.
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
  const raw = await manager.evaluate(LAYOUT_REPORT_SCRIPT);
  return {
    content: `${layoutReportPreamble(url, sessionId)}\n\n${wrapExternalContent(raw, "browser.layout_report")}`,
    metadata: { browserStatus: "layout-report" },
  };
}
