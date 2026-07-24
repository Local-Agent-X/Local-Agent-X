/**
 * Static tool metadata for the `browser` tool — name, description, parameters
 * schema. Split out so the dispatcher file stays focused on behavior.
 */

import { MAX_BROWSER_URL_LENGTH, MAX_NEW_TAB_URLS } from "../../security/layer/browser-egress-eval.js";

export const BROWSER_TOOL_NAME = "browser";

export const BROWSER_TOOL_DESCRIPTION =
  "Control a REAL Chrome browser (visible window on user's desktop) to interact with web pages. " +
  "Its screenshot action captures ONLY the current WEB PAGE/TAB — shown to you INLINE in one call — never the user's physical desktop, monitor, taskbar, or other apps. " +
  "For requests like 'screenshot my screen', 'capture my desktop', or 'show my monitor', use `screen_capture` instead. " +
  "This is NOT headless — the user can see the browser window. " +
  "Use this for sites that require JavaScript rendering, form filling, authentication flows, " +
  "scraping dynamic content, or any task that web_fetch/http_request cannot handle. " +
  "The browser session persists across calls — navigate once, then click/fill/extract as needed. " +
  "IMPORTANT: When a fill or click fails, retry with a different selector or use evaluate to find the right one. " +
  "Don't just tell the user you'll retry — actually call this tool again.\n\n" +
  "WORKFLOW: navigate → snapshot → click/fill by ref. Refs are durable WITHIN the current page — [5] stays [5] across snapshots while that element is on the page. Ref ids are globally unique (a ref never means two different elements), but they only RESOLVE on the page that minted them: after a navigation to a new origin or a switch_tab, old refs are gone, so take a FRESH snapshot before using a ref. Repeat snapshots on the same page emit a DIFF (+ added / - removed / ~ changed) instead of re-listing everything, so you only need to focus on what changed.\n\n" +
  "Actions:\n" +
  "- navigate: Go to a URL (replaces current tab). ALWAYS follow with 'snapshot'.\n" +
  "- new_tab: Open a URL — or MULTIPLE urls at once via 'urls' — in additional co-drivable tabs (keeps current tab open). When the user asks to open several sites, make ONE call with all of them in 'urls'.\n" +
  "- snapshot: Observation with durable refs. First call after navigate → full list (viewport-first). Later calls → diff since last observation. Pass full:true to force a complete re-list of EVERY current element and ref — use it when you no longer have the earlier full list (it scrolled out of your context) instead of guessing refs. Use 'observe' for structured buckets.\n" +
  "- click: Click by ref number (set 'ref') or CSS selector (set 'selector'). Ref is more reliable.\n" +
  "- click_text: Click element by visible text (set 'text'). Good for popups/modals.\n" +
  "- fill: Fill input by ref (set 'ref' + 'value') or CSS selector (set 'selector' + 'value').\n" +
  "- select: Choose dropdown option by CSS selector + value.\n" +
  "- extract: Get visible text from the page or a specific element. On a large page, pass 'find' to get only the matching lines instead of the whole page.\n" +
  "- screenshot: Capture the current page — the image is returned INLINE, so you SEE the page in this one call (no view_image or screen_capture needed). A full-resolution PNG is also saved; use its path with view_image to re-view later or send_image to share it.\n" +
  "- evaluate: Run JavaScript in the page.\n" +
  "- act: Natural language action — 'click the login button', 'fill email with test@test.com'. Figures out the right element from a snapshot automatically.\n" +
  "- observe: Summarize what's actionable on the page — buttons, links, inputs, dropdowns with their ref numbers. Form controls also show live state as {checked}/{unchecked}/{filled}/{disabled}, so re-observe after a click to confirm a checkbox toggled instead of reading the DOM by hand.\n" +
  "- scroll: Scroll the page. value='up'|'down'|'top'|'bottom' OR ref=N to scroll that element into view.\n" +
  "- tabs: List all open tabs with URLs and titles — including the user's own browser tabs, marked [user tab].\n" +
  "- switch_tab: Switch to a tab by index (set 'value' to tab number). Switching onto a [user tab] row TAKES CONTROL of the user's own tab — use it when the user says they're already logged in, or asks you to act on the page they have open. Indexes are as-of the LAST 'tabs' listing; taking over a user tab requires a current listing, and if the tabs changed in between the switch refuses — run 'tabs' again.\n" +
  "- close_tab: Close ONE tab by index (set 'value' to tab number from 'tabs') — done with a tab you opened, close it instead of ending the whole session. Refuses user tabs and the first/only tab (use 'close' for the whole session). Indexes SHIFT after a close; the result includes the fresh listing.\n" +
  "- info: Get current page URL, title, and engine.\n" +
  "- read_console: Read the page's recent console output (errors/warnings/logs, newest last). Check this after acting — especially when verifying an app you're building — instead of guessing why a page is broken. Reads the in-app browser's console; on the external-Chrome fallback it's unavailable.\n" +
  "- read_network: Read recent network request outcomes (HTTP status or failure per request, plus in-flight count). Use it to spot failed API calls / 4xx-5xx responses after acting, especially when verifying an app you're building. Reads the in-app browser's network; unavailable on the external-Chrome fallback.\n" +
  "- downloads: List released, quarantined, rejected, and failed browser downloads for this session.\n" +
  "- release_download: Release a quarantined archive or macro-enabled document after user approval (set 'download_id').\n" +
  "- dialog_accept: Accept a pending dialog. The in-app browser only intercepts beforeunload prompts — alert/confirm/prompt render natively to the co-driving user to handle (the external-Chrome fallback does capture all three). Pass 'value' for a prompt() response on that fallback.\n" +
  "- dialog_dismiss: Dismiss a pending dialog (same caveat: in-app, only beforeunload is interceptable; native alert/confirm/prompt popups belong to the user).\n" +
  "- history: Search shared browser history (pass 'find' to filter, 'limit' to cap rows; newest first). It covers the user's own browsing too — when they mention 'that site from yesterday' or a page they had open, check history FIRST instead of web-searching for it.\n" +
  "- bookmark_add: Save a bookmark. With no 'url'/'title' it bookmarks the CURRENT page. Bookmarks are shared with the user — when they say 'post it to the usual place' or 'save it where I keep those', this is that place.\n" +
  "- bookmarks: List shared bookmarks (pass 'find' to filter). Shared both ways: check here first when the user refers to a saved/usual site.\n" +
  "- close: Close the browser session.\n\n" +
  "TIPS:\n" +
  "- After navigate, ALWAYS take a snapshot before interacting.\n" +
  "- Use click_text for popups/modals where you can see the button text.\n" +
  "- When a login opens a new tab, use 'tabs' then 'switch_tab'.\n" +
  "- When the user says they're logged in on a page, use 'tabs' to find their tab and 'switch_tab' to take it over instead of logging in again.\n\n" +
  "OBSTRUCTIONS (overlays, consent/cookie banners, modals): a snapshot may report " +
  "'OBSTRUCTION DETECTED' with no accept/dismiss button. Do NOT hand the task back to " +
  "the user over this — clear it yourself, in order:\n" +
  "1. click_text on a visible 'Accept'/'Got it'/'Close'/'X' label if there is one.\n" +
  "2. evaluate to remove or hide it: find the overlay node and `el.remove()` " +
  "(or set `el.style.display='none'`), then snapshot again.\n" +
  "3. If it sits over the control you want, scroll/click the underlying element by ref.\n" +
  "Only ask the user to act when the blocker is something ONLY they can supply " +
  "(a password, a 2FA code, a CAPTCHA) — and only after you've actually tried the above. " +
  "While the browser is open and responding, keep driving; don't stop with a summary.";

export const BROWSER_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["navigate", "new_tab", "snapshot", "click", "click_text", "fill", "select", "extract", "screenshot", "evaluate", "act", "observe", "scroll", "tabs", "switch_tab", "close_tab", "info", "read_console", "read_network", "downloads", "release_download", "dialog_accept", "dialog_dismiss", "history", "bookmark_add", "bookmarks", "close"],
      description: "The browser action to perform. Use 'snapshot' to see interactive elements with ref numbers, then 'click' with a ref. Use 'new_tab' to open a URL in a new tab without closing the current one.",
    },
    url: {
      type: "string",
      maxLength: MAX_BROWSER_URL_LENGTH,
      description: "URL to navigate to (required for 'navigate')",
    },
    urls: {
      type: "array",
      maxItems: MAX_NEW_TAB_URLS,
      items: { type: "string", maxLength: MAX_BROWSER_URL_LENGTH },
      description:
        "Multiple URLs for 'new_tab' — ONE call opens one tab per URL. " +
        "Prefer this over repeated new_tab calls when the user asks for several sites. " +
        "Takes precedence over 'url' when both are set.",
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
      description: "Text to type, option to select, or tab index number for 'switch_tab'/'close_tab'",
    },
    script: {
      type: "string",
      description: "JavaScript code to evaluate in the page (required for 'evaluate')",
    },
    full: {
      type: "boolean",
      description:
        "For 'snapshot': force a complete re-list of ALL current elements with their refs instead of a diff. " +
        "Use when the earlier full list is no longer in your context.",
    },
    find: {
      type: "string",
      description: "For 'extract': return only page lines matching this text (case-insensitive) plus context, instead of the whole page. Prefer this when you know what you're looking for on a large page. For 'history'/'bookmarks': substring filter on url/title.",
    },
    limit: {
      type: "number",
      description: "For 'history': maximum entries to return (default 25, max 100).",
    },
    download_id: {
      type: "string",
      description: "Quarantined download ID from the 'downloads' action (required for 'release_download').",
    },
  },
  required: ["action"],
};
