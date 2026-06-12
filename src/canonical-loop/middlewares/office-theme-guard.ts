/**
 * Office theme guard — the house style is the default look for every
 * generated document; a per-call `theme` override is honored ONLY when the
 * user actually asked for a look ("make it red", "use our brand colors",
 * "Times New Roman"). Models love filling optional params: Grok shipped a
 * "scandal red" deck for a plain "make a power point about X" despite the
 * param description saying omit (2026-06-10). Prose doesn't hold; this
 * strips the uninvited override before dispatch — mutating the call args is
 * the established middleware pattern (see auto-build-app).
 */
import type { CanonicalMiddleware } from "./types.js";

// The collapsed family tools (action param). Stripping `theme` is safe for
// every action: only the writing actions consume it, the rest ignore it.
const OFFICE_TOOLS = new Set(["document", "presentation", "pdf", "spreadsheet"]);

/** Does the user's message ask for any specific look? Generous on purpose —
 *  a false keep just honors the model's theme; a false strip loses a real
 *  request, so color words, style words, and font words all count. */
const LOOK_REQUEST_RE =
  /\b(theme|colors?|colou?rs?|styles?|styling|styled|fonts?|typeface|brand|branding|branded|look|design|palette|aesthetic|red|blue|green|purple|violet|orange|pink|yellow|black|white|gr[ae]y|gold|silver|teal|cyan|magenta|crimson|navy|maroon|dark|light|minimal|modern|corporate|professional|playful|elegant|bold)\b/i;

export const officeThemeGuardMiddleware: CanonicalMiddleware = {
  name: "office-theme-guard",

  afterModelCall(ctx) {
    if (LOOK_REQUEST_RE.test(ctx.userMessage)) return { kind: "continue" };
    for (const tc of ctx.toolCalls) {
      if (!OFFICE_TOOLS.has(tc.tool)) continue;
      if (typeof tc.args === "string") {
        try {
          const parsed = JSON.parse(tc.args) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && "theme" in parsed) {
            delete parsed.theme;
            tc.args = JSON.stringify(parsed);
          }
        } catch { /* unparseable args fail in dispatch with a real error */ }
      } else if (tc.args && typeof tc.args === "object" && "theme" in tc.args) {
        delete (tc.args as Record<string, unknown>).theme;
      }
    }
    return { kind: "continue" };
  },
};
