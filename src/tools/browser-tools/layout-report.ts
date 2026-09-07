/**
 * Layout diagnostics — the `layout_report` action.
 *
 * The tool result is the compact JSON string produced by
 * browser/layout-report.ts inside the untrusted-content wrapper, and nothing
 * else: no preamble, no summary, no flags sentence, no emulation profile. The
 * page names itself — the JSON `url` is the page's own location.href. The
 * backend's getCurrentUrl() is not printed because the in-app backend stamps
 * it only on navigate/observe/getInfo (in-app-backend.ts), so after a
 * click-navigation it is stale; it is still what the sensitive-page gate
 * below is keyed on — the same url the dispatcher's own gate (index.ts)
 * reads — and that staleness is a separate, unaddressed issue.
 *
 * What layout-report.test.ts proves: the result text is byte-for-byte
 * wrapExternalContent(<what evaluate returned>, "browser.layout_report") for
 * a clean report, a truncated report, a non-JSON string and a session with an
 * emulation profile installed; the constant clears the evaluate blocklist and
 * the handler refuses if it ever stops clearing it; one evaluate call and no
 * mutating backend method.
 *
 * The wrapper edits the bytes it is given: it strips <system>...</system>
 * spans (across string boundaries), control and invisible chars and its own
 * markers, and normalizes homoglyphs. The script serializes so that none of
 * those occur in its bytes (Invariant 2 in browser/layout-report.ts, proven
 * against a real page and the real wrapper in
 * test/browser-layout-report-adversarial.test.ts); layout-report.test.ts
 * shows the escape is load-bearing — the same document unescaped is rewritten.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/backend.js";
import { LAYOUT_REPORT_SCRIPT } from "../../browser/layout-report.js";
import { scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
import { err } from "./shared.js";

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
    content: wrapExternalContent(raw, "browser.layout_report"),
    metadata: { browserStatus: "layout-report" },
  };
}
