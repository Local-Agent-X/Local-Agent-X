/**
 * Browser tool — aggregator + dispatcher.
 *
 * One tool (`browser`) with an `action` discriminator. The per-action handlers
 * live in src/tools/browser-tools/:
 *   shared.ts      — ok/err helpers, auth-wall detector, post-action snapshot,
 *                    input-ref lister, VALID_ENGINES
 *   description.ts — static tool name + description + parameters schema
 *   navigation.ts  — navigate, new_tab, snapshot
 *   interact.ts    — click, click_text, fill, select, scroll
 *   page.ts        — extract, screenshot, evaluate, info, tabs, switch_tab,
 *                    dialog_accept, dialog_dismiss, close
 *   act.ts         — act (natural-language)
 *   observe.ts     — observe (role-bucketed, diff-aware view)
 */

import type { ToolDefinition, ToolResult } from "../../types.js";
import type { ServerEvent } from "../../types.js";
import { getBrowserManager, closeBrowser, withBrowserLock, resetWedgedBrowser, BrowserWedgeError } from "../../browser/index.js";
import type { BrowserEngine, BrowserBackend, WedgeRecoveryOutcome } from "../../browser/index.js";
import { getToolTimeout } from "../../tool-execution/tool-timeout.js";
import { raceWedgeDeadline, WEDGED } from "./wedge-deadline.js";
import { VALID_ENGINES, err } from "./shared.js";
import {
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_TOOL_PARAMETERS,
} from "./description.js";
import { handleNavigate, handleNewTab, handleSnapshot } from "./navigation.js";
import {
  handleClick,
  handleClickText,
  handleFill,
  handleSelect,
  handleScroll,
} from "./interact.js";
import {
  handleExtract,
  handleScreenshot,
  handleEvaluate,
  handleInfo,
  handleTabs,
  handleSwitchTab,
  handleCloseTab,
  handleDialogAccept,
  handleDialogDismiss,
  handleClose,
  handleDownloads,
  handleReleaseDownload,
} from "./page.js";
import { handleAct } from "./act.js";
import { handleHistory, handleBookmarkAdd, handleBookmarks } from "./library.js";
import { handleObserve } from "./observe.js";
import { handleReadConsole, handleReadNetwork } from "./perception.js";
import { recordProgress, resetProgress } from "../../browser/progress-tracker.js";
import { createLogger } from "../../logger.js";
import { sensitivePageActionDecision, sensitivePageStub } from "../../browser/guards.js";
import { getApprovalManager } from "../../approval-manager.js";
import { blocked, declined } from "../result-helpers.js";

// Names the action that wedged. Without it the circuit-breaker FAIL only says
// "an action hung" — which action is left to inference. The destructive part is
// the force-kill, so knowing whether it was click_text / evaluate / act / a scan
// is what tells you where the next unbounded operation to cap lives.
const log = createLogger("browser.wedge");

// Actions that establish a fresh page context — clear stall state, don't compare.
// close_tab counts: closing the active tab moves the agent onto a different page.
const RESET_ACTIONS = new Set(["navigate", "new_tab", "switch_tab", "close_tab", "close"]);
// Advancing actions where "page never changed" means the agent is stuck.
// Click-style actions AND local edits (fill / select / scroll) all count: the
// enriched fingerprint (interactions.ts) tracks value length, scroll position,
// checked/selected state, and aria-expanded, so a PRODUCTIVE edit moves the
// fingerprint (never false-trips) while a dead one that changes nothing is
// still caught — this tracker is the ONLY browser-layer spin bound. Only pure
// READS (snapshot / observe / extract / screenshot / info / tabs) are excluded:
// a read never "tries to move the page", and blocking the agent's own
// re-perceive recovery move with the stall error is the opposite of helpful.
const TRACKED_ACTIONS = new Set(["click", "click_text", "fill", "select", "scroll", "act"]);
const READ_ONLY_ACTIONS = new Set(["snapshot", "extract", "screenshot", "tabs", "info", "observe", "read_console", "read_network", "history", "bookmarks"]);

/** Wedge outcome → what the agent is told. Honest about what survived: an
 *  in-place recovery keeps the tab and page; a recreated view reloads its last
 *  page on the next action; a CDP reset opens a fresh Chrome. All three end
 *  the same way — the action never completed, so retry it. */
function wedgeRecoveryMessage(outcome: WedgeRecoveryOutcome): string {
  switch (outcome) {
    case "recovered-in-place":
      return (
        "The browser hung on that action, but the page is still responsive — the browser " +
        "recovered in place (same tab, same page). The action did not complete; simply retry it."
      );
    case "view-recreated":
      return (
        "The browser view stopped responding and was recreated; it will reload its last page " +
        "on your next browser action. The action did not complete — retry it."
      );
    case "cdp-reset":
      return (
        "The browser stopped responding and its session was reset. The action did not " +
        "complete — retry it and a fresh browser will open."
      );
  }
}

/**
 * After an advancing action, fingerprint the page and trip a no-progress stop
 * if the session has spun without moving the page. The isError result feeds the
 * circuit breaker (run-sandboxed records isError as a failure), so an agent that
 * ignores the warning and keeps hammering gets a hard cooldown.
 */
async function applyProgressGuard(
  action: string,
  manager: BrowserBackend,
  sessionId: string,
  result: ToolResult,
): Promise<ToolResult> {
  // Co-drive preemption: the human took the wheel, so the action never ran —
  // an unchanged page here is NOT the agent spinning. Reset instead of
  // recording, so a preempted stretch can't false-trip the breaker.
  if (result.metadata?.userActive === true) {
    resetProgress(sessionId);
    return result;
  }
  if (RESET_ACTIONS.has(action)) {
    resetProgress(sessionId);
    return result;
  }
  if (!TRACKED_ACTIONS.has(action) || result.isError) return result;
  // Defense in depth: a read-only action never represents "trying to move the
  // page", so its result — often the agent's own re-perceive recovery move —
  // must never be replaced by the stall error. TRACKED_ACTIONS already excludes
  // reads; this makes the invariant explicit and regression-proof.
  if (READ_ONLY_ACTIONS.has(action)) return result;
  // Cap the fingerprint read: a hung page-eval here must not ride the outer
  // tool timeout and report a completed action as a timeout. Timing out yields
  // "" — recordProgress treats that as "unknown" (neither progress nor stall).
  let fpTimer: ReturnType<typeof setTimeout> | undefined;
  const fingerprint = await Promise.race([
    manager.fingerprint(),
    new Promise<string>((resolve) => { fpTimer = setTimeout(() => resolve(""), 2000); }),
  ]);
  clearTimeout(fpTimer);
  const { stalled, unchanged } = recordProgress(sessionId, fingerprint);
  if (!stalled) return result;
  return err(
    `No page change after ${unchanged} consecutive browser actions — the page is not responding to what you're doing. ` +
    `Stop repeating the same action. Try a different approach: a different ref/selector, scroll to reveal off-screen ` +
    `elements, navigate elsewhere, or stop and ask the user. Repeating will open the circuit breaker.`,
  );
}

/**
 * Creates the browser tool for web interaction via Playwright.
 * Single tool with an "action" parameter to keep token costs low.
 * Supports Chromium, Firefox, and WebKit engines.
 * @param getSessionId - Returns the current session ID (thread-safe, no global state)
 */
export function createBrowserTools(getSessionId?: () => string): ToolDefinition[] {
  const browserTool: ToolDefinition = {
    name: BROWSER_TOOL_NAME,
    effect: (args) => READ_ONLY_ACTIONS.has(String(args.action || ""))
      ? { class: "read-only" }
      : { class: "non-idempotent" },
    description: BROWSER_TOOL_DESCRIPTION,
    parameters: BROWSER_TOOL_PARAMETERS,
    async execute(args) {
      const action = String(args.action || "");
      // Use session ID from tool executor (per-request, no global state) or fall back to getter
      const sessionId = args._sessionId ? String(args._sessionId) : (getSessionId ? getSessionId() : "default");
      const onEvent = (args._onEvent && typeof args._onEvent === "function") ? args._onEvent as (e: { type: string; [k: string]: unknown }) => void : undefined;
      return withBrowserLock(sessionId, async () => {
        const manager = getBrowserManager(sessionId);

        // Validate engine if provided
        const engine = args.engine ? String(args.engine) as BrowserEngine : undefined;
        if (engine && !VALID_ENGINES.includes(engine)) {
          return err(`Invalid engine: "${engine}". Must be one of: ${VALID_ENGINES.join(", ")}`);
        }

        try {
          if (action === "release_download") {
            const id = String(args.download_id || "");
            if (!id) return err("'download_id' is required. Use action='downloads' first.");
            if (!onEvent) return blocked(
              "BLOCKED: quarantined downloads can only be released from an interactive session with explicit user approval.",
              { layer: "browser-download", browserStatus: "approval-required" },
            );
            let approvalBinding: ReturnType<BrowserBackend["getDownloadApproval"]>;
            try { approvalBinding = manager.getDownloadApproval(id); }
            catch (error) { return blocked(`BLOCKED: ${(error as Error).message}`, { layer: "browser-download", browserStatus: "not-releasable" }); }
            const outcome = await getApprovalManager().requestApprovalDetailed({
              toolName: "browser.release_download",
              toolCallId: String(args._toolCallId || `browser-release-${id}`),
              sessionId,
              context: "Release a quarantined browser download into workspace/downloads. The file remains unavailable to agent tools until approved.",
              args: { action: "release_download", ...approvalBinding },
              alwaysAsk: true,
              emit: onEvent as (event: ServerEvent) => void,
            });
            if (!outcome.approved) return declined(
              "Download release was not approved; the file remains quarantined.",
              { layer: "browser-download", browserStatus: "quarantined", downloadId: id },
            );
            args._downloadApproval = approvalBinding;
          } else {
            const pageDecision = sensitivePageActionDecision(manager.getCurrentUrl(), action);
            if (pageDecision.disposition === "blocked") return blocked(
              `BLOCKED: ${pageDecision.reason}`,
              { layer: "browser-sensitive-page", browserStatus: "blocked", category: pageDecision.category },
            );
            if (pageDecision.disposition === "approval-required") {
              if (!onEvent) return blocked(
                `BLOCKED: ${pageDecision.reason} Explicit approval is unavailable in this run.`,
                { layer: "browser-sensitive-page", browserStatus: "approval-required", category: pageDecision.category },
              );
              const outcome = await getApprovalManager().requestApprovalDetailed({
                toolName: "browser.sensitive_page_action",
                toolCallId: String(args._toolCallId || `browser-sensitive-${sessionId}`),
                sessionId,
                context: `${pageDecision.reason} Approve only if you expect this action. Page contents and form values are intentionally omitted.`,
                args: { action, category: pageDecision.category, page: pageDecision.page },
                alwaysAsk: true,
                emit: onEvent as (event: ServerEvent) => void,
              });
              if (!outcome.approved) return declined(
                `Sensitive-page ${action} was not approved; no browser action was performed.`,
                { layer: "browser-sensitive-page", browserStatus: "declined", category: pageDecision.category },
              );
            }
          }
          const dispatch = (async (): Promise<ToolResult> => {
          switch (action) {
            case "navigate": return await handleNavigate(manager, args, engine);
            case "new_tab": return await handleNewTab(manager, args);
            case "snapshot": return await handleSnapshot(manager, args);
            case "click": return await handleClick(manager, args);
            case "click_text": return await handleClickText(manager, args);
            case "fill": return await handleFill(manager, args);
            case "select": return await handleSelect(manager, args);
            case "extract": return await handleExtract(manager, args);
            case "screenshot": return await handleScreenshot(manager);
            case "evaluate": return await handleEvaluate(manager, args);
            case "scroll": return await handleScroll(manager, args);
            case "tabs": return await handleTabs(manager);
            case "switch_tab": return await handleSwitchTab(manager, args);
            case "close_tab": return await handleCloseTab(manager, args);
            case "info": return await handleInfo(manager);
            case "downloads": return await handleDownloads(manager);
            case "release_download": return await handleReleaseDownload(manager, args);
            case "history": return handleHistory(args);
            case "bookmark_add": return await handleBookmarkAdd(manager, args);
            case "bookmarks": return handleBookmarks(args);
            case "dialog_accept": return await handleDialogAccept(manager, args);
            case "dialog_dismiss": return await handleDialogDismiss(manager);
            case "close": return await handleClose(sessionId);
            case "act": return await handleAct(manager, args);
            case "observe": return await handleObserve(manager);
            case "read_console": return await handleReadConsole(manager);
            case "read_network": return await handleReadNetwork(manager);
            default:
              return err(
                `Unknown action: "${action}". Valid actions: navigate, click, fill, select, extract, screenshot, evaluate, act, observe, tabs, switch_tab, info, close`
              );
          }
          })();

          // In-process hang recovery: fire just under the per-tool browser
          // timeout (tool-timeout.ts) and recover the wedged session so the
          // NEXT call works — instead of the outer timeout abandoning the call
          // and leaving the wedged session to be reused until LAX restarts.
          // See wedge-deadline.ts / instance.ts:resetWedgedBrowser.
          const toolMs = getToolTimeout(BROWSER_TOOL_NAME);
          const deadlineMs = toolMs > 0 ? Math.max(1_000, toolMs - 1_000) : 0;
          let recovery: Promise<WedgeRecoveryOutcome> | undefined;
          const result = await raceWedgeDeadline(dispatch, deadlineMs, () => {
            recovery = resetWedgedBrowser(sessionId);
          });
          if (result === WEDGED) {
            // raceWedgeDeadline invoked the reset callback before returning
            // WEDGED, so `recovery` is set; await it so the next action (the
            // per-session lock releases when we return) sees settled state.
            const outcome = await recovery!;
            log.warn(`action '${action}' hung past ${deadlineMs}ms — wedge recovery: ${outcome}`);
            return err(wedgeRecoveryMessage(outcome));
          }
          const sensitive = sensitivePageStub(manager.getCurrentUrl());
          if (sensitive) {
            return {
              content: sensitive,
              isError: result.isError,
              status: result.status,
              metadata: { ...result.metadata, browserStatus: "sensitive-content-withheld" },
            };
          }
          return await applyProgressGuard(action, manager, sessionId, result);
        } catch (e) {
          const sensitive = sensitivePageStub(manager.getCurrentUrl());
          if (sensitive) return blocked(sensitive, { layer: "browser-sensitive-page", browserStatus: "sensitive-content-withheld" });
          const message = (e as Error).message;
          if (e instanceof BrowserWedgeError) {
            // A page scan hung. Recover now — ~10s in — so the next call
            // works, rather than waiting out the 30s tool timeout and reusing
            // the wedged session. Soft recovery keeps the view and its URL.
            const outcome = await resetWedgedBrowser(sessionId);
            log.warn(`action '${action}' wedged during page scan — wedge recovery: ${outcome}`);
            return err(wedgeRecoveryMessage(outcome));
          }
          if (message.includes("Timeout")) {
            // Auto-recovery: snapshot the page anyway — it may be partially usable
            try {
              const snap = await manager.snapshot();
              return err(`Browser timeout (page may still be loading). Current page state:\n\n${snap}`);
            } catch {
              return err(`Browser timeout: ${message}. Page could not be read.`);
            }
          }
          if (message.includes("selector resolved to")) {
            return err(`Selector issue: ${message}. Try a different CSS selector.`);
          }
          if (message.includes("Target closed") || message.includes("has been closed")) {
            // Auto-recovery: browser crashed — next call to getPage() will relaunch
            return err(`Browser crashed and has been restarted. Please retry your last action.`);
          }
          return err(`Browser error: ${message}`);
        }
      }, () => {
        if (onEvent) onEvent({ type: "browser_queued", sessionId });
      });
    },
  };

  return [browserTool];
}

export { closeBrowser };
