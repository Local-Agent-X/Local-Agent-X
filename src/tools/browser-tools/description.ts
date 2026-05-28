/**
 * Static tool metadata for the `browser` tool — name, description, parameters
 * schema. Split out so the dispatcher file stays focused on behavior.
 */

export const BROWSER_TOOL_NAME = "browser";

export const BROWSER_TOOL_DESCRIPTION =
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
  "- dialog_accept: Accept a pending native browser dialog (alert/confirm/prompt). Pass 'value' for prompt() responses.\n" +
  "- dialog_dismiss: Dismiss a pending native browser dialog.\n" +
  "- close: Close the browser session.\n\n" +
  "TIPS:\n" +
  "- After navigate, ALWAYS take a snapshot before interacting.\n" +
  "- Use click_text for popups/modals where you can see the button text.\n" +
  "- When a login opens a new tab, use 'tabs' then 'switch_tab'.";

export const BROWSER_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["navigate", "new_tab", "snapshot", "click", "click_text", "fill", "select", "extract", "screenshot", "evaluate", "act", "observe", "scroll", "tabs", "switch_tab", "info", "dialog_accept", "dialog_dismiss", "close"],
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
};
