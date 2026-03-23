import type { ToolDefinition, ToolResult } from "./types.js";
import { getBrowserManager, closeBrowser } from "./browser.js";
import type { BrowserEngine } from "./browser.js";

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
 */
export function createBrowserTools(): ToolDefinition[] {
  const browserTool: ToolDefinition = {
    name: "browser",
    description:
      "Control a headless browser to interact with web pages. " +
      "Supports 3 engines: chromium (default), firefox, and webkit (Safari). " +
      "Use this for sites that require JavaScript rendering, form filling, authentication flows, " +
      "scraping dynamic content, or any task that web_fetch/http_request cannot handle. " +
      "The browser session persists across calls — navigate once, then click/fill/extract as needed.\n\n" +
      "Actions:\n" +
      "- navigate: Go to a URL, returns page text. Set 'engine' to switch browsers.\n" +
      "- click: Click an element by CSS selector\n" +
      "- fill: Type text into an input field\n" +
      "- select: Choose an option from a dropdown\n" +
      "- extract: Get visible text from the page or a specific element\n" +
      "- screenshot: Capture the current page\n" +
      "- evaluate: Run JavaScript in the page\n" +
      "- info: Get current page URL, title, and engine\n" +
      "- close: Close the browser session",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "click", "fill", "select", "extract", "screenshot", "evaluate", "info", "close"],
          description: "The browser action to perform",
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
        selector: {
          type: "string",
          description: "CSS selector for the target element (required for 'click', 'fill', 'select'; optional for 'extract')",
        },
        value: {
          type: "string",
          description: "Text to type or option to select (required for 'fill' and 'select')",
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
      const manager = getBrowserManager();

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
            return ok(await manager.navigate(url, engine));
          }

          case "click": {
            const selector = String(args.selector || "");
            if (!selector) return err("'selector' parameter is required for click action.");
            return ok(await manager.click(selector));
          }

          case "fill": {
            const selector = String(args.selector || "");
            const value = String(args.value ?? "");
            if (!selector) return err("'selector' parameter is required for fill action.");
            return ok(await manager.fill(selector, value));
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
            return ok(await manager.evaluate(script));
          }

          case "info": {
            return ok(await manager.getInfo());
          }

          case "close": {
            await closeBrowser();
            return ok("Browser session closed.");
          }

          default:
            return err(
              `Unknown action: "${action}". Valid actions: navigate, click, fill, select, extract, screenshot, evaluate, info, close`
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
