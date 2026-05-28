/**
 * Browser tool — aggregator + dispatcher.
 *
 * One tool (`browser`) with an `action` discriminator. The per-action handlers
 * live in src/browser-tools/:
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

import type { ToolDefinition } from "../types.js";
import { getBrowserManager, closeBrowser, withBrowserLock } from "../browser.js";
import type { BrowserEngine } from "../browser.js";
import { VALID_ENGINES, err } from "./browser-tools/shared.js";
import {
  BROWSER_TOOL_NAME,
  BROWSER_TOOL_DESCRIPTION,
  BROWSER_TOOL_PARAMETERS,
} from "./browser-tools/description.js";
import { handleNavigate, handleNewTab, handleSnapshot } from "./browser-tools/navigation.js";
import {
  handleClick,
  handleClickText,
  handleFill,
  handleSelect,
  handleScroll,
} from "./browser-tools/interact.js";
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
} from "./browser-tools/page.js";
import { handleAct } from "./browser-tools/act.js";
import { handleObserve } from "./browser-tools/observe.js";

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
        } catch (e) {
          const message = (e as Error).message;
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
