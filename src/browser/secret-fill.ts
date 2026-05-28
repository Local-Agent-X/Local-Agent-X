// Privacy-preserving secret fill into live browser pages.
//
// Counterpart to browser-secret-capture.ts. The capture flow reads DOM → vault
// and is safe because it doesn't create new exposure. Fill is structurally more
// dangerous: it takes a vault value and paints it onto a page. If the page is
// hostile or mis-identified, we've just leaked the secret.
//
// Five guardrails enforce safety, in this order:
//   1. Selector whitelist — only <input type="password"> or autocomplete hints
//      username/current-password/new-password. Refuses arbitrary elements.
//   2. Origin binding — the current page's origin must match the secret's
//      recorded origin (from capture or user-entered login URL). No override.
//   3. Approval ladder — the call must satisfy AT LEAST one of:
//      (a) Same-session provenance: this session captured the secret.
//      (b) User-saved approval for {secret, origin} in the vault.
//      (c) Operation pre-bless: user passed pre_blessed_secrets to
//          operation_start this run.
//      Otherwise returns an error asking for approval. Never silently proceeds.
//   4. Post-fill redaction — the plaintext value is registered with
//      registerRedactedSecretValue so subsequent snapshots / extracts /
//      evaluate outputs scrub it before reaching the LLM.
//   5. Audit log — every fill (allowed or denied) logs to stderr with
//      {secret, origin, selector_kind, path, outcome, reason}.
//
// The LLM orchestrates but never sees the plaintext. Return text says "filled"
// and length only; no value, no echo, no truncated prefix.

import type { ToolDefinition, ToolResult } from "../types.js";
import type { SecretsStore } from "../secrets.js";
import { deriveOrigin } from "../secrets.js";
import { getBrowserManager } from "./index.js";
import { registerRedactedSecretValue } from "../sanitize.js";
import { getActivePreBlessedSecrets } from "../operations/executor.js";
import { loadOperation } from "../operations/conductor.js";
import { join } from "node:path";

import { createLogger } from "../logger.js";
const logger = createLogger("browser-secret-fill");

function ok(content: string): ToolResult { return { content }; }
function err(content: string): ToolResult { return { content, isError: true }; }

/** Selectors we will fill into. Anything else is refused. */
const ALLOWED_SELECTOR_PATTERNS: Array<{ test: (el: { tag: string; type?: string; autocomplete?: string }) => boolean; label: string }> = [
  { label: "input[type=password]", test: (el) => el.tag === "input" && el.type === "password" },
  { label: "input[autocomplete=current-password]", test: (el) => el.tag === "input" && el.autocomplete === "current-password" },
  { label: "input[autocomplete=new-password]", test: (el) => el.tag === "input" && el.autocomplete === "new-password" },
  { label: "input[autocomplete=username]", test: (el) => el.tag === "input" && el.autocomplete === "username" },
  { label: "input[autocomplete=email]", test: (el) => el.tag === "input" && el.autocomplete === "email" },
];

function operationsWorkspace(): string {
  return join(process.cwd(), "workspace", "operations");
}

function loadOpForPreBless(operationId: string): { preBlessedSecrets?: string[] } | null {
  const op = loadOperation(operationsWorkspace(), operationId);
  if (!op) return null;
  return { preBlessedSecrets: op.preBlessedSecrets };
}

function auditLog(row: Record<string, unknown>): void {
  try {
    logger.warn(`[secret-fill] ${JSON.stringify(row)}`);
  } catch { /* never throw from audit */ }
}

export function createBrowserSecretFillTool(
  secretsStore: SecretsStore,
  getSessionId?: () => string,
): ToolDefinition {
  return {
    name: "browser_fill_from_secret",
    description:
      "Privacy-preserving fill: writes a stored secret into a browser input field server-side. " +
      "The value never passes through you (the model), chat, logs, or subsequent snapshots. " +
      "Use this for login forms and any credentialed field when Chrome autofill can't/won't populate " +
      "(CDP-driven pages don't count as user gestures, so Chrome's password manager often won't fire).\n\n" +
      "GUARDRAILS (all enforced server-side):\n" +
      " • Field must be <input type=\"password\"> or have autocomplete=username|email|current-password|new-password.\n" +
      " • Current page origin MUST match the secret's recorded origin — no cross-origin fill, ever.\n" +
      " • First use of a given {secret, origin} pair requires user approval UNLESS this session captured the secret itself OR the user pre-blessed it via operation_start.preBlessedSecrets. If denied, the error tells you exactly how to get approval.\n\n" +
      "After a successful fill the plaintext value is added to the snapshot/extract redaction list — it can't leak back to you via subsequent tool output.\n\n" +
      "Pass `ref` (from a browser.snapshot) OR `selector` (CSS). Prefer ref.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Secret name (SCREAMING_SNAKE_CASE) already present in the vault. List with secret_list.",
        },
        ref: {
          type: "integer",
          description: "Numeric ref from a recent browser.snapshot. Preferred — more reliable than CSS selectors.",
        },
        selector: {
          type: "string",
          description: "CSS selector for the target <input>. Used only when ref is not provided.",
        },
        press_enter: {
          type: "boolean",
          description: "After filling, press Enter in the field. Default false.",
        },
      },
      required: ["name"],
    },
    async execute(args) {
      const rawName = String(args.name || "");
      const name = rawName.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (!name) return err("Secret name is required.");

      const ref = typeof args.ref === "number" ? args.ref : undefined;
      const selector = args.selector ? String(args.selector) : undefined;
      if (ref === undefined && !selector) {
        return err("Provide `ref` (from a recent snapshot) or `selector` (CSS).");
      }
      const pressEnter = args.press_enter === true;
      const sessionId = args._sessionId ? String(args._sessionId) : (getSessionId ? getSessionId() : "default");
      const { withBrowserLock } = await import("./index.js");
      return withBrowserLock(sessionId, async () => {

      // Look up secret metadata. We do NOT pull the value yet — only confirm it
      // exists and inspect origin/provenance. Value fetch is deferred to the
      // last possible moment before page.fill().
      const meta = secretsStore.getMeta(name);
      if (!meta) {
        auditLog({ event: "fill_denied", secret: name, reason: "not_in_vault", session: sessionId });
        return err(`Secret "${name}" is not in the vault. Use secret_list to see what's stored, or capture it with browser_capture_to_secret.`);
      }

      // --- Guardrail 1: identify the target element + check selector whitelist ---
      const manager = getBrowserManager(sessionId);
      let page;
      try {
        page = await manager.getPage();
      } catch (e) {
        return err(`Browser not available: ${(e as Error).message}`);
      }

      const currentOrigin = (() => { try { return new URL(page.url()).origin; } catch { return ""; } })();
      if (!currentOrigin) {
        auditLog({ event: "fill_denied", secret: name, reason: "no_current_origin", session: sessionId });
        return err("Browser has no current page origin — navigate somewhere first.");
      }

      // Resolve ref → selector via the observation registry if ref was provided.
      // We use evaluate() with a generated selector to inspect the target node's
      // tag/type/autocomplete server-side, so the decision doesn't depend on
      // anything the LLM said.
      const targetSelector = selector ?? `[data-lax-ref="${ref}"]`;
      interface ElementDescriptor { tag: string; type: string; autocomplete: string; found: boolean }
      let elementDescriptor: ElementDescriptor = { tag: "", type: "", autocomplete: "", found: false };
      try {
        const script = `(function(sel){
          var el = document.querySelector(sel);
          if (!el) return { found: false, tag: '', type: '', autocomplete: '' };
          return {
            found: true,
            tag: (el.tagName || '').toLowerCase(),
            type: (el.getAttribute('type') || '').toLowerCase(),
            autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
          };
        })(${JSON.stringify(targetSelector)})`;
        const raw = await page.evaluate(script);
        if (raw && typeof raw === "object") {
          const r = raw as Partial<ElementDescriptor>;
          elementDescriptor = {
            tag: String(r.tag ?? ""),
            type: String(r.type ?? ""),
            autocomplete: String(r.autocomplete ?? ""),
            found: Boolean(r.found),
          };
        }
      } catch (e) {
        return err(`Could not inspect target element: ${(e as Error).message}`);
      }

      if (!elementDescriptor.found) {
        auditLog({ event: "fill_denied", secret: name, reason: "element_not_found", selector: targetSelector, session: sessionId });
        return err(`Target element not found (selector: ${targetSelector}). Take a fresh snapshot and retry.`);
      }

      const matchedPattern = ALLOWED_SELECTOR_PATTERNS.find((p) => p.test(elementDescriptor));
      if (!matchedPattern) {
        auditLog({
          event: "fill_denied", secret: name, reason: "selector_not_whitelisted",
          tag: elementDescriptor.tag, type: elementDescriptor.type, autocomplete: elementDescriptor.autocomplete,
          origin: currentOrigin, session: sessionId,
        });
        return err(
          `Refused to fill: target is <${elementDescriptor.tag}` +
          (elementDescriptor.type ? ` type="${elementDescriptor.type}"` : "") +
          (elementDescriptor.autocomplete ? ` autocomplete="${elementDescriptor.autocomplete}"` : "") +
          `>. browser_fill_from_secret only writes into password/username/email credential fields. ` +
          `If this is a credential field missing an autocomplete attribute, add \`autocomplete="username"\` or similar on the site — or just have the user fill it manually.`
        );
      }

      // --- Guardrail 2: origin binding ---
      const secretOrigin = meta.origin ?? deriveOrigin(meta.url);
      if (!secretOrigin) {
        auditLog({ event: "fill_denied", secret: name, reason: "secret_has_no_origin", session: sessionId });
        return err(
          `Secret "${name}" has no recorded origin. Fill requires origin binding. ` +
          `Edit the secret to add a login URL (Settings → Secrets), then retry.`
        );
      }
      if (currentOrigin !== secretOrigin) {
        auditLog({
          event: "fill_denied", secret: name, reason: "origin_mismatch",
          currentOrigin, secretOrigin, session: sessionId,
        });
        return err(
          `Cross-origin fill blocked. Current page is ${currentOrigin} but secret "${name}" is bound to ${secretOrigin}. ` +
          `If you need this secret on a different site, the user must save a separate secret with the new origin — this is not approvable.`
        );
      }

      // --- Guardrail 3: approval ladder ---
      const sameSession = !!(meta.createdBySession && sessionId && meta.createdBySession === sessionId);
      const userApproved = secretsStore.isFillApproved(name, currentOrigin);
      const preBlessed = getActivePreBlessedSecrets(loadOpForPreBless).has(name);

      const gateOutcome: "session" | "approved" | "pre_bless" | "denied" =
        sameSession ? "session" :
        userApproved ? "approved" :
        preBlessed ? "pre_bless" :
        "denied";

      if (gateOutcome === "denied") {
        auditLog({
          event: "fill_denied", secret: name, reason: "first_use_approval_required",
          origin: currentOrigin, session: sessionId,
        });
        return err(
          `First-use approval required for secret "${name}" on ${currentOrigin}. ` +
          `This secret was not captured by the current session and has not been pre-approved. ` +
          `How to proceed: (a) Ask the user to open Settings → Secrets → "${name}" and approve "${currentOrigin}" (one-click, persists). ` +
          `Or (b) if this is part of an operation, restart the operation with operation_start(..., pre_blessed_secrets: ["${name}"]) — the user must pass that list explicitly. ` +
          `Do NOT re-try this call until one of those is done; you will just hit the same error.`
        );
      }

      // --- Fetch value + perform the fill ---
      const value = secretsStore.get(name);
      if (!value) {
        // Race: entry was deleted between getMeta and get
        return err(`Secret "${name}" disappeared between check and read. Retry or ask the user.`);
      }

      try {
        if (ref !== undefined && !selector) {
          // Playwright locator via attr-selector still reaches the right node
          await page.locator(targetSelector).fill(value);
        } else {
          await page.fill(targetSelector, value);
        }
        if (pressEnter) {
          await page.locator(targetSelector).press("Enter");
        }
      } catch (e) {
        auditLog({
          event: "fill_failed", secret: name, origin: currentOrigin, session: sessionId,
          selectorKind: matchedPattern.label, error: (e as Error).message,
        });
        return err(`Fill failed: ${(e as Error).message}`);
      }

      // --- Guardrail 4: post-fill redaction so value can't leak back via snapshots ---
      registerRedactedSecretValue(value);

      // --- Guardrail 5: audit log (success) ---
      auditLog({
        event: "fill_allowed", secret: name, origin: currentOrigin, session: sessionId,
        selectorKind: matchedPattern.label, gate: gateOutcome, pressEnter,
      });

      const gateExplain =
        gateOutcome === "session" ? "approved (same session captured this secret)" :
        gateOutcome === "approved" ? "approved (user-saved approval for this origin)" :
        "approved (operation pre-blessed this secret)";

      return ok(
        `Filled ${matchedPattern.label} on ${currentOrigin} with secret "${name}" [${gateExplain}]. ` +
        `Length: ${value.length} chars. Value is NOT shown to you. ` +
        (pressEnter ? "Pressed Enter after fill. " : "") +
        `Take a new snapshot to see the next page state.`
      );
      });
    },
  };
}
