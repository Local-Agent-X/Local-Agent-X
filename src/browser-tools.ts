import { promises as dns } from "node:dns";
import type { ToolDefinition, ToolResult } from "./types.js";
import { getBrowserManager, closeBrowser } from "./browser.js";
import type { BrowserEngine } from "./browser.js";

/**
 * DNS pinning for browser navigate — prevents rebinding to private IPs.
 * EXCEPTION: localhost/127.0.0.1 is allowed (user's own dev servers).
 */
async function dnsPinCheck(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // Allow localhost and 127.0.0.1 — user's own dev servers
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return null;
    }

    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
    const addrs = await dns.resolve4(host).catch(() => [] as string[]);
    for (const ip of addrs) {
      const [a, b] = ip.split(".").map(Number);
      // Block private networks (but NOT 127.x — already handled above)
      if (a === 10 || a === 0 || a >= 224) return `DNS rebinding blocked: ${host} → ${ip}`;
      if (a === 192 && b === 168) return `DNS rebinding blocked: ${host} → ${ip}`;
      if (a === 172 && b >= 16 && b <= 31) return `DNS rebinding blocked: ${host} → ${ip}`;
      if (a === 169 && b === 254) return `DNS rebinding blocked: ${host} → ${ip}`;
    }
  } catch { /* DNS failure ok */ }
  return null;
}

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
      "WORKFLOW: navigate → snapshot → click/fill by ref. The snapshot shows numbered refs for every interactive element.\n\n" +
      "Actions:\n" +
      "- navigate: Go to a URL (replaces current tab). ALWAYS follow with 'snapshot'.\n" +
      "- new_tab: Open a URL in a NEW tab (keeps current tab open).\n" +
      "- snapshot: Get accessibility tree with numbered refs (e.g. [1] button \"Log in\"). ALWAYS use this before clicking.\n" +
      "- click: Click by ref number (set 'ref') or CSS selector (set 'selector'). Ref is more reliable.\n" +
      "- click_text: Click element by visible text (set 'text'). Good for popups/modals.\n" +
      "- fill: Fill input by ref (set 'ref' + 'value') or CSS selector (set 'selector' + 'value').\n" +
      "- select: Choose dropdown option by CSS selector + value.\n" +
      "- extract: Get visible text from the page or a specific element.\n" +
      "- screenshot: Capture the current page.\n" +
      "- evaluate: Run JavaScript in the page.\n" +
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
          enum: ["navigate", "new_tab", "snapshot", "click", "click_text", "fill", "select", "extract", "screenshot", "evaluate", "tabs", "switch_tab", "info", "close"],
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
      const sessionId = getSessionId ? getSessionId() : "default";
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
            return ok(await manager.snapshot());
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
            return ok(await manager.extractText(selector));
          }

          case "screenshot": {
            return ok(await manager.screenshot());
          }

          case "evaluate": {
            const script = String(args.script || "");
            if (!script) return err("'script' parameter is required for evaluate action.");
            // Block dangerous patterns: network exfiltration, cookie/storage theft, DOM escape
            const blocked = [
              // Network exfiltration
              /\bfetch\s*\(/i,
              /\bXMLHttpRequest\b/i,
              /\bnew\s+WebSocket\b/i,
              /\bnavigator\.sendBeacon\b/i,
              /\bwindow\.open\b/i,
              /\bimportScripts\b/i,
              // Image/form-based exfiltration
              /\bnew\s+Image\b/i,
              /\.src\s*=/i,
              /\.submit\s*\(/i,
              /\.action\s*=/i,
              /createElement\s*\(\s*['"]script['"]\s*\)/i,
              /createElement\s*\(\s*['"]iframe['"]\s*\)/i,
              /createElement\s*\(\s*['"]img['"]\s*\)/i,
              /createElement\s*\(\s*['"]form['"]\s*\)/i,
              /createElement\s*\(\s*['"]link['"]\s*\)/i,
              /createElement\s*\(\s*['"]object['"]\s*\)/i,
              // Storage/credential theft
              /\bdocument\.cookie\b/i,
              /\blocalStorage\b/i,
              /\bsessionStorage\b/i,
              /\bindexedDB\b/i,
              /\bcredentials\b/i,
              // Dynamic code execution
              /\beval\s*\(/i,
              /\bFunction\s*\(/i,
              /\bsetTimeout\s*\(\s*['"]/i,
              /\bsetInterval\s*\(\s*['"]/i,
            ];
            for (const pattern of blocked) {
              if (pattern.test(script)) {
                return err(
                  `Blocked: script contains restricted pattern (${pattern.source}). ` +
                  `evaluate() is for DOM inspection only — use http_request for API calls.`
                );
              }
            }
            return ok(await manager.evaluate(script));
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

          default:
            return err(
              `Unknown action: "${action}". Valid actions: navigate, click, fill, select, extract, screenshot, evaluate, tabs, switch_tab, info, close`
            );
        }
      } catch (e) {
        const message = (e as Error).message;
        if (message.includes("Timeout")) {
          return err(`Browser timeout: ${message}. The element may not exist or the page may still be loading.`);
        }
        if (message.includes("selector resolved to")) {
          return err(`Selector issue: ${message}. Try a different CSS selector.`);
        }
        return err(`Browser error: ${message}`);
      }
    },
  };

  return [browserTool];
}

export { closeBrowser };
