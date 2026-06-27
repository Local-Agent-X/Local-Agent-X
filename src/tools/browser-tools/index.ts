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
import { getBrowserManager, closeBrowser, withBrowserLock, resetWedgedBrowser, BrowserWedgeError } from "../../browser/index.js";
import type { BrowserEngine, BrowserManager } from "../../browser/index.js";
import { getToolTimeout } from "../../tool-timeout.js";
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
  handleDialogAccept,
  handleDialogDismiss,
  handleClose,
} from "./page.js";
import { handleAct } from "./act.js";
import { handleObserve } from "./observe.js";
import { recordProgress, resetProgress } from "../../browser/progress-tracker.js";
import { createLogger } from "../../logger.js";

// Names the action that wedged. Without it the circuit-breaker FAIL only says
// "an action hung" — which action is left to inference. The destructive part is
// the force-kill, so knowing whether it was click_text / evaluate / act / a scan
// is what tells you where the next unbounded operation to cap lives.
const log = createLogger("browser.wedge");

// Actions that establish a fresh page context — clear stall state, don't compare.
const RESET_ACTIONS = new Set(["navigate", "new_tab", "switch_tab", "close"]);
// Advancing actions where "page never changed" means the agent is stuck.
// Pure reads/utilities (extract, screenshot, evaluate, info, tabs, dialogs)
// are excluded: they legitimately return varying data off an unchanged page.
const TRACKED_ACTIONS = new Set(["click", "click_text", "fill", "select", "scroll", "observe", "snapshot", "act"]);

/**
 * After an advancing action, fingerprint the page and trip a no-progress stop
 * if the session has spun without moving the page. The isError result feeds the
 * circuit breaker (run-sandboxed records isError as a failure), so an agent that
 * ignores the warning and keeps hammering gets a hard cooldown.
 */
async function applyProgressGuard(
  action: string,
  manager: BrowserManager,
  sessionId: string,
  result: ToolResult,
): Promise<ToolResult> {
  if (RESET_ACTIONS.has(action)) {
    resetProgress(sessionId);
    return result;
  }
  if (!TRACKED_ACTIONS.has(action) || result.isError) return result;
  const { stalled, unchanged } = recordProgress(sessionId, await manager.fingerprint());
  if (!stalled) return result;
  return err(
    `No page change after ${unchanged} consecutive browser actions — the page is not responding to what you're doing. ` +
    `Stop repeating the same action. Try a different approach: a different ref/selector, scroll to reveal off-screen ` +
    `elements, re-navigate, or stop and ask the user. Repeating will open the circuit breaker.`,
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
          const dispatch = (async (): Promise<ToolResult> => {
          switch (action) {
            case "navigate": return await handleNavigate(manager, args, engine);
            case "new_tab": return await handleNewTab(manager, args);
            case "snapshot": return await handleSnapshot(manager);
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
            case "info": return await handleInfo(manager);
            case "dialog_accept": return await handleDialogAccept(manager, args);
            case "dialog_dismiss": return await handleDialogDismiss(manager);
            case "close": return await handleClose(sessionId);
            case "act": return await handleAct(manager, args);
            case "observe": return await handleObserve(manager);
            default:
              return err(
                `Unknown action: "${action}". Valid actions: navigate, click, fill, select, extract, screenshot, evaluate, act, observe, tabs, switch_tab, info, close`
              );
          }
          })();

          // In-process hang recovery: fire just under the per-tool browser
          // timeout (tool-timeout.ts) and force-reset the wedged session so the
          // NEXT call re-acquires a fresh Chrome — instead of the outer timeout
          // abandoning the call and leaving the wedged Chrome to be reused until
          // LAX restarts. See wedge-deadline.ts / instance.ts:resetWedgedBrowser.
          const toolMs = getToolTimeout(BROWSER_TOOL_NAME);
          const deadlineMs = toolMs > 0 ? Math.max(1_000, toolMs - 1_000) : 0;
          const result = await raceWedgeDeadline(dispatch, deadlineMs, () => resetWedgedBrowser(sessionId));
          if (result === WEDGED) {
            log.warn(`action '${action}' hung past ${deadlineMs}ms — session force-reset`);
            return err(
              "The browser stopped responding (an action hung) and its session was reset. " +
              "Your last action did not complete — retry it and a fresh browser will open.",
            );
          }
          return await applyProgressGuard(action, manager, sessionId, result);
        } catch (e) {
          const message = (e as Error).message;
          if (e instanceof BrowserWedgeError) {
            // A page scan hung (wedged CDP connection). Reset now — ~10s — so
            // the next call re-acquires a fresh Chrome, rather than waiting out
            // the 30s tool timeout and reusing the wedged session.
            log.warn(`action '${action}' wedged during page scan — session force-reset`);
            resetWedgedBrowser(sessionId);
            return err(
              "The browser stopped responding while scanning the page and its session was reset. " +
              "Retry your last action — a fresh browser will open.",
            );
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
