/**
 * Browser tool — aggregator + dispatcher.
 *
 * One tool (`browser`) with an `action` discriminator. The per-action handlers
 * live in src/tools/browser-tools/:
 *   shared.ts        — ok/err helpers, auth-wall detector, post-action snapshot,
 *                      input-ref lister, VALID_ENGINES
 *   description.ts   — static tool name + description + parameters schema
 *   action-tables.ts — action classification tables (reset / tracked /
 *                      read-only / human-verification-blocked)
 *   gates.ts         — pre-dispatch approval gates, human-verification block,
 *                      post-dispatch progress guard
 *   navigation.ts    — navigate, new_tab, snapshot
 *   interact.ts      — click, click_text, fill, select, scroll
 *   page.ts          — extract, screenshot, evaluate, info, tabs, switch_tab,
 *                      dialog_accept, dialog_dismiss, close
 *   act.ts           — act (natural-language)
 *   observe.ts       — observe (role-bucketed, diff-aware view)
 */

import type { ToolDefinition, ToolResult } from "../../types.js";
import { getBrowserManager, closeBrowser, withBrowserLock, resetWedgedBrowser, BrowserWedgeError } from "../../browser/index.js";
import type { BrowserEngine, WedgeRecoveryOutcome } from "../../browser/index.js";
import { getToolTimeout } from "../../tool-execution/tool-timeout.js";
import { raceWedgeDeadline, WEDGED } from "./wedge-deadline.js";
import { VALID_ENGINES, err } from "./shared.js";
import {
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_TOOL_PARAMETERS,
} from "./description.js";
import { READ_ONLY_ACTIONS } from "./action-tables.js";
import { applyProgressGuard, humanVerificationBlock, runPreDispatchGates } from "./gates.js";
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
import { handleReadConsole, handleReadNetwork, handleReadResponse } from "./perception.js";
import { createLogger } from "../../logger.js";
import { runWithSensitiveReadGrant, secrecyOpenWarning, sensitivePageStub } from "../../browser/guards.js";
import { blocked } from "../result-helpers.js";

// Names the action that wedged. Without it the circuit-breaker FAIL only says
// "an action hung" — which action is left to inference. The destructive part is
// the force-kill, so knowing whether it was click_text / evaluate / act / a scan
// is what tells you where the next unbounded operation to cap lives.
const log = createLogger("browser.wedge");

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
          const gated = await runPreDispatchGates(action, args, manager, sessionId, onEvent);
          if (gated.kind === "halt") return gated.result;
          const grantedReadUrl = gated.grantedReadUrl;
          // Everything from dispatch through the post-dispatch stub backstop
          // and the open-warning runs as ONE unit so an approved read grant
          // can scope to exactly this call's async context.
          const runGated = async (): Promise<ToolResult> => {
          const verificationBlock = await humanVerificationBlock(action, manager);
          if (verificationBlock) return verificationBlock;
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
            case "read_response": return await handleReadResponse(manager, args);
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
          const finalResult = await applyProgressGuard(action, manager, sessionId, result);
          // Open-level transparency: the first browser call of a session that
          // ENDS on a secret-bearing page (any action — landing snapshots and
          // post-mutation snapshots carry content at open too) names the
          // cloud provider the contents go to.
          const openWarning = secrecyOpenWarning(sessionId, manager.getCurrentUrl());
          return openWarning && typeof finalResult.content === "string"
            ? { ...finalResult, content: `${openWarning}\n\n${finalResult.content}` }
            : finalResult;
          };
          return grantedReadUrl
            ? await runWithSensitiveReadGrant(grantedReadUrl, runGated)
            : await runGated();
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
