import type { ToolDefinition, ToolResult } from "./types.js";
import { getBrowserManager, closeBrowser } from "./browser.js";
import type { BrowserEngine } from "./browser.js";
import { wrapExternalContent } from "./sanitize.js";
import { dnsPinCheck, scanEvaluateScript } from "./browser/guards.js";

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

const VALID_ENGINES: BrowserEngine[] = ["chromium", "firefox", "webkit"];

/**
 * Creates the browser tool for web interaction via Playwright.
 * Single tool with an "action" parameter to keep token costs low.
 * Supports Chromium, Firefox, and WebKit engines.
 * @param getSessionId - Returns the current session ID (thread-safe, no global state)
 */
export function createBrowserTools(getSessionId?: () => string): ToolDefinition[] {
  const browserTool: ToolDefinition = {
    name: "browser",
    description:
      "Control a REAL Chrome browser (visible window on user's desktop) to interact with web pages. " +
      "This is NOT headless — the user can see the browser window. " +
      "Use this for sites that require JavaScript rendering, form filling, authentication flows, " +
      "scraping dynamic content, or any task that web_fetch/http_request cannot handle. " +
      "The browser session persists across calls — navigate once, then click/fill/extract as needed. " +
      "IMPORTANT: When a fill or click fails, retry with a different selector or use evaluate to find the right one. " +
      "Don't just tell the user you'll retry — actually call this tool again.\n\n" +
      "WORKFLOW: navigate → snapshot → click/fill by ref. Refs are DURABLE — [5] stays [5] across snapshots as long as the element is still on the page. Subsequent snapshots emit a DIFF (+ added / - removed / ~ changed) instead of re-listing everything, so you only need to focus on what changed.\n\n" +
      "Actions:\n" +
      "- navigate: Go to a URL (replaces current tab). ALWAYS follow with 'snapshot'.\n" +
      "- new_tab: Open a URL in a NEW tab (keeps current tab open).\n" +
      "- snapshot: Observation with durable refs. First call after navigate → full list (viewport-first). Later calls → diff since last observation. Use 'observe' for structured buckets.\n" +
      "- click: Click by ref number (set 'ref') or CSS selector (set 'selector'). Ref is more reliable.\n" +
      "- click_text: Click element by visible text (set 'text'). Good for popups/modals.\n" +
      "- fill: Fill input by ref (set 'ref' + 'value') or CSS selector (set 'selector' + 'value').\n" +
      "- select: Choose dropdown option by CSS selector + value.\n" +
      "- extract: Get visible text from the page or a specific element.\n" +
      "- screenshot: Capture the current page.\n" +
      "- evaluate: Run JavaScript in the page.\n" +
      "- act: Natural language action — 'click the login button', 'fill email with test@test.com'. Figures out the right element from a snapshot automatically.\n" +
      "- observe: Summarize what's actionable on the page — buttons, links, inputs, dropdowns with their ref numbers.\n" +
      "- scroll: Scroll the page. value='up'|'down'|'top'|'bottom' OR ref=N to scroll that element into view.\n" +
      "- tabs: List all open tabs with URLs and titles.\n" +
      "- switch_tab: Switch to a tab by index (set 'value' to tab number).\n" +
      "- info: Get current page URL, title, and engine.\n" +
      "- close: Close the browser session.\n\n" +
      "TIPS:\n" +
      "- After navigate, ALWAYS take a snapshot before interacting.\n" +
      "- Use click_text for popups/modals where you can see the button text.\n" +
      "- When a login opens a new tab, use 'tabs' then 'switch_tab'.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "new_tab", "snapshot", "click", "click_text", "fill", "select", "extract", "screenshot", "evaluate", "act", "observe", "scroll", "tabs", "switch_tab", "info", "close"],
          description: "The browser action to perform. Use 'snapshot' to see interactive elements with ref numbers, then 'click' with a ref. Use 'new_tab' to open a URL in a new tab without closing the current one.",
        },
        url: {
          type: "string",
          description: "URL to navigate to (required for 'navigate')",
        },
        engine: {
          type: "string",
          enum: ["chromium", "firefox", "webkit"],
          description:
            "Browser engine to use (optional, default: chromium). " +
            "chromium = Chrome/Edge, firefox = Firefox, webkit = Safari. " +
            "Switching engine closes the current session and opens a new one.",
        },
        ref: {
          type: "number",
          description: "Ref number from snapshot (preferred for click/fill — more reliable than CSS selectors)",
        },
        selector: {
          type: "string",
          description: "CSS selector (fallback — use ref from snapshot instead when possible)",
        },
        text: {
          type: "string",
          description: "Visible text to click (for 'click_text' action — clicks element containing this text)",
        },
        value: {
          type: "string",
          description: "Text to type, option to select, or tab index number for 'switch_tab'",
        },
        script: {
          type: "string",
          description: "JavaScript code to evaluate in the page (required for 'evaluate')",
        },
      },
      required: ["action"],
    },
    async execute(args) {
      const action = String(args.action || "");
      // Use session ID from tool executor (per-request, no global state) or fall back to getter
      const sessionId = args._sessionId ? String(args._sessionId) : (getSessionId ? getSessionId() : "default");
      const manager = getBrowserManager(sessionId);

      // Validate engine if provided
      const engine = args.engine ? String(args.engine) as BrowserEngine : undefined;
      if (engine && !VALID_ENGINES.includes(engine)) {
        return err(`Invalid engine: "${engine}". Must be one of: ${VALID_ENGINES.join(", ")}`);
      }

      try {
        switch (action) {
          case "navigate": {
            const url = String(args.url || "");
            if (!url) return err("'url' parameter is required for navigate action.");
            // DNS rebinding protection — resolve hostname before browser navigates
            const pinResult = await dnsPinCheck(url);
            if (pinResult) return err(pinResult);
            return ok(await manager.navigate(url, engine));
          }

          case "new_tab": {
            const url = String(args.url || "");
            if (!url) return err("'url' parameter is required for new_tab action.");
            const pinResult2 = await dnsPinCheck(url);
            if (pinResult2) return err(pinResult2);
            return ok(await manager.newTab(url));
          }

          case "snapshot": {
            const raw = await manager.snapshot();
            return ok(wrapExternalContent(raw, "browser.snapshot"));
          }

          case "click": {
            // Prefer ref (from snapshot) over CSS selector
            if (args.ref !== undefined && args.ref !== null) {
              const ref = Number(args.ref);
              if (isNaN(ref)) return err("'ref' must be a number from the snapshot.");
              return ok(await manager.clickByRef(ref));
            }
            const selector = String(args.selector || "");
            if (!selector) return err("Provide 'ref' (from snapshot) or 'selector' (CSS) for click.");
            return ok(await manager.click(selector));
          }

          case "click_text": {
            const text = String(args.text || "");
            if (!text) return err("'text' parameter is required for click_text action.");
            return ok(await manager.clickByText(text));
          }

          case "fill": {
            const value = String(args.value ?? "");
            // Prefer ref over CSS selector
            if (args.ref !== undefined && args.ref !== null) {
              const ref = Number(args.ref);
              if (isNaN(ref)) return err("'ref' must be a number from the snapshot.");
              return ok(await manager.fillByRef(ref, value));
            }
            const selector = String(args.selector || "");
            if (!selector) return err("Provide 'ref' (from snapshot) or 'selector' (CSS) for fill.");
            try {
              return ok(await manager.fill(selector, value));
            } catch {
              // Auto-recovery fallbacks
              const alternatives = [
                "input[type='text']:first-of-type",
                "input[type='email']:first-of-type",
                "input:first-of-type",
              ];
              for (const alt of alternatives) {
                try {
                  const result = await manager.fill(alt, value);
                  return ok(result + `\n(used fallback "${alt}")`);
                } catch { continue; }
              }
              return err(`Could not fill "${selector}". Use 'snapshot' action to find the right ref.`);
            }
          }

          case "select": {
            const selector = String(args.selector || "");
            const value = String(args.value || "");
            if (!selector || !value) return err("'selector' and 'value' are required for select action.");
            return ok(await manager.select(selector, value));
          }

          case "extract": {
            const selector = args.selector ? String(args.selector) : undefined;
            const raw = await manager.extractText(selector);
            return ok(wrapExternalContent(raw, "browser.extract"));
          }

          case "screenshot": {
            return ok(await manager.screenshot());
          }

          case "evaluate": {
            const script = String(args.script || "");
            if (!script) return err("'script' parameter is required for evaluate action.");
            const blockedPattern = scanEvaluateScript(script);
            if (blockedPattern) {
              return err(
                `Blocked: script contains restricted pattern (${blockedPattern}). ` +
                `evaluate() is for DOM inspection only — use http_request for API calls.`
              );
            }
            return ok(await manager.evaluate(script));
          }

          case "scroll": {
            // value = "up" | "down" | "top" | "bottom" | "<number>" (for refId)
            // OR ref = number to scroll that element into view
            const refVal = args.ref !== undefined && args.ref !== null ? Number(args.ref) : undefined;
            const direction = args.value ? String(args.value) as "up" | "down" | "top" | "bottom" : "down";
            return ok(await manager.scroll({ direction, refId: refVal }));
          }

          case "tabs": {
            return ok(await manager.listTabs());
          }

          case "switch_tab": {
            const tabIndex = parseInt(String(args.value || "0"), 10);
            if (isNaN(tabIndex)) return err("'value' must be a tab index number. Use 'tabs' action to list tabs.");
            return ok(await manager.switchTab(tabIndex));
          }

          case "info": {
            return ok(await manager.getInfo());
          }

          case "close": {
            await closeBrowser(sessionId);
            return ok("Browser session closed.");
          }

          // ── Intelligent Actions (Stagehand-inspired) ──
          // These accept natural language and figure out which element to interact with.
          // They work by: snapshot → match instruction to elements → perform action.

          case "act": {
            // Natural language action: "click the login button", "fill in the search box with 'cats'"
            const instruction = String(args.text || args.value || "");
            if (!instruction) return err("'text' parameter required for act. Describe what to do: 'click the login button', 'fill search with cats'.");

            // Get current page state
            const snap = await manager.snapshot();
            const lines = snap.split("\n").filter(l => l.trim());

            // Parse instruction to determine action type
            const lowerInst = instruction.toLowerCase();
            const isFill = /\b(fill|type|enter|input|write|set)\b/.test(lowerInst);
            const isClick = /\b(click|press|tap|select|choose|toggle|check|uncheck|submit|open)\b/.test(lowerInst);

            // Extract target text from instruction
            // "click the login button" → target = "login"
            // "fill email with test@test.com" → target = "email", value = "test@test.com"
            const words = instruction.replace(/['"]/g, "").split(/\s+/);

            if (isFill) {
              // Extract field name and value from instruction
              const withIdx = words.findIndex(w => w.toLowerCase() === "with");
              const fieldWords = words.slice(0, withIdx > 0 ? withIdx : words.length).filter(w => !/^(fill|type|enter|input|write|set|in|the|a|an)$/i.test(w));
              const valueWords = withIdx > 0 ? words.slice(withIdx + 1) : [];
              const fieldName = fieldWords.join(" ").toLowerCase();
              const fillValue = valueWords.join(" ") || String(args.value || "");

              // Find matching ref in snapshot
              const match = lines.find(l => {
                const lower = l.toLowerCase();
                return (lower.includes("input") || lower.includes("textbox") || lower.includes("combobox") || lower.includes("searchbox")) &&
                       fieldName.split(" ").some(w => w.length > 2 && lower.includes(w));
              });
              if (match) {
                const refMatch = match.match(/\[(\d+)\]/);
                if (refMatch) {
                  const ref = parseInt(refMatch[1]);
                  const result = await manager.fillByRef(ref, fillValue);
                  return ok(`Filled ref [${ref}] with "${fillValue}". ${result}`);
                }
              }
              // Fallback: try click_text on the field label, then fill
              return err(`Could not find input matching "${fieldName}". Take a snapshot to see available refs.`);
            }

            if (isClick) {
              // Find matching element in snapshot
              const targetWords = words.filter(w => !/^(click|press|tap|select|choose|toggle|submit|open|the|a|an|on|button|link)$/i.test(w));
              const target = targetWords.join(" ").toLowerCase();

              const match = lines.find(l => {
                const lower = l.toLowerCase();
                return target.split(" ").filter(w => w.length > 2).every(w => lower.includes(w));
              });
              if (match) {
                const refMatch = match.match(/\[(\d+)\]/);
                if (refMatch) {
                  const ref = parseInt(refMatch[1]);
                  const result = await manager.clickByRef(ref);
                  return ok(`Clicked ref [${ref}] (matched "${target}"). ${result}`);
                }
              }
              // Fallback: try click_text
              try {
                const result = await manager.clickByText(target);
                return ok(`Clicked text "${target}". ${result}`);
              } catch {
                return err(`Could not find element matching "${target}". Take a snapshot to see available elements.`);
              }
            }

            return err(`Could not parse action from "${instruction}". Try: "click the X button" or "fill email with test@test.com".`);
          }

          case "observe": {
            // Structured view grouped by role, viewport-first, diff-aware
            const obs = await manager.observe();
            const source = obs.isInitial && obs.full ? obs.full : [...obs.added];
            const visible = source.filter((r) => r.inViewport);

            const bucket = (names: string[]) => visible.filter((r) => names.includes(r.role));
            const buttons = bucket(["button"]);
            const links = bucket(["link"]);
            const inputs = bucket(["textbox", "searchbox", "combobox"]);
            const selects = bucket(["combobox", "listbox"]);
            const checks = bucket(["checkbox", "radio", "switch"]);

            const fmt = (r: { id: number; role: string; name: string }) =>
              `  [${r.id}] ${r.role} "${r.name.slice(0, 80)}"`;

            const parts: string[] = [];
            parts.push(`Page: ${obs.title} (${obs.url})`);
            parts.push(`${obs.totalCount} elements (${obs.totalCount - obs.offscreenCount} in viewport, ${obs.offscreenCount} below fold)`);
            if (!obs.isInitial) {
              parts.push(`Since last observation: +${obs.added.length} added, -${obs.removed.length} removed, ~${obs.changed.length} changed`);
            }
            parts.push("");
            parts.push(`Buttons (${buttons.length}):`, ...buttons.slice(0, 20).map(fmt));
            parts.push("", `Links (${links.length}):`, ...links.slice(0, 15).map(fmt));
            parts.push("", `Inputs (${inputs.length}):`, ...inputs.slice(0, 15).map(fmt));
            parts.push("", `Dropdowns (${selects.length}):`, ...selects.slice(0, 10).map(fmt));
            parts.push("", `Checkboxes/Radios (${checks.length}):`, ...checks.slice(0, 10).map(fmt));
            return ok(parts.join("\n"));
          }

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
    },
  };

  return [browserTool];
}

export { closeBrowser };
