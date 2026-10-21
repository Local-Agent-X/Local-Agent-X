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
//   3. Approval ladder — SecretsStore.destinationDecision, the one every
//      emitter runs (ADR 0005): the secret's own recorded origin; the session
//      that captured it; an operation the user pre-blessed it for; a pair the
//      user approved. Otherwise the user is asked in the chat, once per origin,
//      and a yes is kept. Never silently proceeds on a sibling origin.
//   4. Post-fill redaction — the plaintext value is registered with
//      registerRedactedSecretValue so subsequent snapshots / extracts /
//      evaluate outputs scrub it before reaching the LLM.
//   5. Audit log — every fill (allowed or denied) logs to stderr with
//      {secret, origin, selector_kind, path, outcome, reason}.
//
// The LLM orchestrates but never sees the plaintext. Return text says "filled"
// and length only; no value, no echo, no truncated prefix.

import type { ToolDefinition, ToolResult } from "../types.js";
import type { DestinationDecision, SecretsStore } from "../secrets.js";
import { deriveOrigin, normalizeSecretName } from "../secrets.js";
import { getSecretBrowserOps } from "./index.js";
import { withEmulationNotice } from "../tools/browser-tools/emulation-banner.js";
import { registerRedactedSecretValue, vaultSecretSource } from "../security/secrets/index.js";
import type { SecretElementDescriptor, SecretFillOutcome } from "./secret-ops.js";
import { sameSite } from "./registrable-domain.js";
import { requestSecretDestinationApprovals } from "../secret-destination-gate.js";
import { sessionIdOf, userGrantOf } from "../tool-execution/internal-args.js";
import type { ServerEvent } from "../types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("browser-secret-fill");

/** Why a fill was allowed, in the words its result gives the model. */
const FILL_GATE_EXPLAINED: Record<"account-name" | "asked" | "granted" | Exclude<DestinationDecision, "ask">, string> = {
  "account-name": "an email address: an account name, not a credential",
  origin: "approved (the site this secret was saved for)",
  session: "approved (same session captured this secret)",
  approved: "approved (user-saved approval for this origin)",
  asked: "approved by the user just now for this origin",
  granted: "approved by the user from their inbox, for this fill only",
  pre_bless: "approved (operation pre-blessed this secret)",
  planned: "approved (the user named this site for this scheduled job's key)",
};

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

/** A login EMAIL may also go into a plain text or email box: it is an account
 *  name, not a credential, and many sign-in pages (Twilio's) mark their
 *  username box with nothing. Refusing it left the agent no way to log in. */
const EMAIL_INTO_TEXT_FIELD = {
  label: "input[type=text|email] (an email address)",
  test: (el: { tag: string; type?: string }) => el.tag === "input" && ["", "text", "email"].includes(el.type ?? ""),
};

/** The audited refusal for a fill the page did not land, or null when it did
 *  (landed, or masked so the page could not confirm). Value-free by
 *  construction: the outcome never carried one. */
function refusedFillOutcome(
  outcome: SecretFillOutcome,
  ctx: { name: string; currentOrigin: string; sessionId: string; selectorKind: string; targetSelector: string },
): ToolResult | null {
  const { name, currentOrigin, sessionId, selectorKind, targetSelector } = ctx;
  if (outcome.kind === "origin-changed") {
    auditLog({ event: "fill_denied", secret: name, reason: "origin_changed", origin: currentOrigin, session: sessionId });
    return err(`Fill refused: the page left ${currentOrigin} before the value was written. Take a new snapshot and retry on the page you mean.`);
  }
  if (outcome.kind === "not-found" || outcome.kind === "not-fillable") {
    auditLog({ event: "fill_failed", secret: name, origin: currentOrigin, session: sessionId, selectorKind, error: outcome.kind });
    return err(`Fill failed: target ${targetSelector} is ${outcome.kind.replace("-", " ")}.`);
  }
  if (outcome.kind === "mismatch") {
    auditLog({ event: "fill_mismatch", secret: name, origin: currentOrigin, session: sessionId, selectorKind });
    return err(`Secret fill did not land: ${targetSelector} (value mismatch)`);
  }
  return null;
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
      " • Field must be <input type=\"password\"> or have autocomplete=username|email|current-password|new-password; a stored email address may also fill a plain text/email box.\n" +
      " • The page must be the secret's recorded origin or another page of that same site — never another site.\n" +
      " • The first fill on a page that is not the secret's recorded origin asks the user once in the chat (a yes is kept for that origin), unless this session captured the secret or an op_submit_async run pre-blessed it; on a sibling page of the site, only the user's own yes counts. A declined fill returns status declined.\n\n" +
      "After a successful fill the plaintext value is added to the snapshot/extract redaction list — it can't leak back to you via subsequent tool output.\n\n" +
      "Pass `ref` (from a browser.snapshot) OR `selector` (CSS). Prefer ref.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Secret name (SCREAMING_SNAKE_CASE) already present in the vault. List with list_secrets.",
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
      const name = normalizeSecretName(String(args.name || ""));
      if (!name) return err("Secret name is required.");

      const ref = typeof args.ref === "number" ? args.ref : undefined;
      const selector = args.selector ? String(args.selector) : undefined;
      if (ref === undefined && !selector) {
        return err("Provide `ref` (from a recent snapshot) or `selector` (CSS).");
      }
      const pressEnter = args.press_enter === true;
      const sessionId = sessionIdOf(args) ?? (getSessionId ? getSessionId() : "default");
      const { withBrowserLock } = await import("./index.js");
      // This tool reaches the page through getSecretBrowserOps, NOT the browser
      // dispatcher, so the standing emulation notice has to be applied here as
      // well: while a profile is installed the fill lands in the PRIVATE emulated
      // context (getSecretBrowserOps follows the same override), not the user's
      // logged-in in-app view, and nothing else in this result says so. Applied
      // over every exit below; the four argument-validation refusals ABOVE this
      // line carry no notice, because none of them touched a page.
      const locked = await withBrowserLock(sessionId, async () => {

      // Look up secret metadata. We do NOT pull the value yet — only confirm it
      // exists and inspect origin/provenance. Value fetch is deferred to the
      // last possible moment before page.fill().
      const meta = secretsStore.getMeta(name);
      if (!meta) {
        auditLog({ event: "fill_denied", secret: name, reason: "not_in_vault", session: sessionId });
        return err(`Secret "${name}" is not in the vault. Use list_secrets to see what's stored, or capture it with browser_capture_to_secret.`);
      }

      // --- Guardrail 1: identify the target element + check selector whitelist ---
      const ops = getSecretBrowserOps(sessionId);

      let currentOrigin: string;
      try {
        currentOrigin = await ops.currentOrigin();
      } catch (e) {
        return err(`Browser not available: ${(e as Error).message}`);
      }
      if (!currentOrigin) {
        auditLog({ event: "fill_denied", secret: name, reason: "no_current_origin", session: sessionId });
        return err("Browser has no current page origin — navigate somewhere first.");
      }

      // Resolve ref → selector via the observation registry if ref was provided.
      // The target node's tag/type/autocomplete are read server-side, so the
      // decision doesn't depend on anything the LLM said.
      // A snapshot ref resolves through the backend's own registry (a stale ref
      // recovered the way clicks recover it); nothing else marks the page, and
      // a bare [data-lax-ref] selector matched nothing, so every ref fill failed.
      const targetSelector = selector ?? await ops.markRef(ref!);
      if (!targetSelector) {
        auditLog({ event: "fill_denied", secret: name, reason: "ref_not_found", ref, session: sessionId });
        return err(`Ref [${ref}] is not on the page any more. Take a fresh snapshot and retry with the field's new ref.`);
      }
      let elementDescriptor: SecretElementDescriptor;
      try {
        elementDescriptor = await ops.describeElement(targetSelector);
      } catch (e) {
        return err(`Could not inspect target element: ${(e as Error).message}`);
      }

      if (!elementDescriptor.found) {
        auditLog({ event: "fill_denied", secret: name, reason: "element_not_found", selector: targetSelector, session: sessionId });
        return err(`Target element not found (selector: ${targetSelector}). Take a fresh snapshot and retry.`);
      }

      const matchedPattern = ALLOWED_SELECTOR_PATTERNS.find((p) => p.test(elementDescriptor))
        ?? (secretsStore.holdsEmailAddress(name) && EMAIL_INTO_TEXT_FIELD.test(elementDescriptor) ? EMAIL_INTO_TEXT_FIELD : undefined);
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
      // The secret's own origin, or another page of the same site: Twilio signs
      // in at login.twilio.com for a login saved on www.twilio.com, and refusing
      // that left no way to log in. A sibling origin is never filled silently
      // (a big site hosts other people's pages, sites.google.com), so the user
      // approves it below, once. Another site is never filled.
      const sameOrigin = currentOrigin === secretOrigin;
      if (!sameOrigin && !sameSite(currentOrigin, secretOrigin)) {
        auditLog({
          event: "fill_denied", secret: name, reason: "origin_mismatch",
          currentOrigin, secretOrigin, session: sessionId,
        });
        return err(
          `Cross-origin fill blocked. Current page is ${currentOrigin} but secret "${name}" is bound to ${secretOrigin}. ` +
          `If you need this secret on a different site, the user must save a separate secret with the new origin — this is not approvable.`
        );
      }

      // --- Guardrail 3: approval ladder (the shared one, ADR 0005) ---
      // An email address is an account name, not a credential (known-secrets.ts):
      // where it may be typed is not a decision to ask the user about. It still
      // goes only to its own site (above).
      const accountName = secretsStore.holdsEmailAddress(name);
      // exactOrigin: a page under the saved origin is not the saved origin for
      // a password; it is asked about below like any other sibling page.
      const ladder = secretsStore.destinationDecision(name, currentOrigin, { sessionId, exactOrigin: true });
      // A sibling origin is never filled silently: only the user's own yes for
      // that pair skips the ask there.
      const decision = !sameOrigin && (ladder === "session" || ladder === "pre_bless") ? "ask" : ladder;
      let gateOutcome: "account-name" | "asked" | "granted" | DestinationDecision = accountName ? "account-name" : decision;

      // Not yet approved here: ask the user in the chat, once per origin,
      // instead of sending them to Settings mid-login. The user's yes to this
      // exact call from their inbox (an unattended run parked it) stands in for
      // the card, for this one fill: nothing is persisted for the origin.
      if (gateOutcome === "ask" && userGrantOf(args)) gateOutcome = "granted";
      if (gateOutcome === "ask") {
        const asked = await requestSecretDestinationApprovals(
          [{ name, destination: currentOrigin, purpose: `Fill ${name} into the form on ${currentOrigin}${sameOrigin ? "" : ` (it was saved for ${secretOrigin})`}` }],
          { store: secretsStore, sessionId, toolName: "browser_fill_from_secret", call: args },
        );
        if (!asked.allowed) {
          if (asked.result.status === "declined") auditLog({ event: "fill_denied", secret: name, reason: "user_declined", origin: currentOrigin, session: sessionId });
          else auditLog({ event: "fill_denied", secret: name, reason: "first_use_approval_required", origin: currentOrigin, session: sessionId });
          return asked.result;
        }
        gateOutcome = "asked";
      }

      // --- Fetch value + perform the fill ---
      const value = secretsStore.get(name);
      if (!value) {
        // Race: entry was deleted between getMeta and get
        return err(`Secret "${name}" disappeared between check and read. Retry or ask the user.`);
      }

      // --- Guardrail 4: redaction BEFORE the write, so a snapshot taken between
      // the fill and the registration (or after a fill that failed half-way)
      // can't leak the value back. The value is the user's stored secret
      // whether or not the write lands; registering it costs nothing real.
      registerRedactedSecretValue(value, vaultSecretSource(name));

      // The write and its verification happen together, inside the page — the
      // outcome that comes back carries no value, so nothing below can echo the
      // secret even by accident. The page judges that it is still on the origin
      // the fill was approved for in the same script, so a navigation during
      // the approval wait cannot redirect the value. Verification precedes
      // pressEnter so a post-submit navigation can't tear the element out from
      // under it.
      let outcome: SecretFillOutcome;
      try {
        outcome = await ops.fillValue(targetSelector, value, currentOrigin);
      } catch (e) {
        auditLog({
          event: "fill_failed", secret: name, origin: currentOrigin, session: sessionId,
          selectorKind: matchedPattern.label, error: (e as Error).message,
        });
        return err(`Fill failed: ${(e as Error).message}`);
      }

      const refused = refusedFillOutcome(outcome, { name, currentOrigin, sessionId, selectorKind: matchedPattern.label, targetSelector });
      if (refused) return refused;
      const verificationNote = outcome.kind === "masked-unverifiable" ? " (verification skipped: masked input)" : "";

      if (pressEnter) {
        try {
          await ops.pressEnter(targetSelector);
        } catch (e) {
          auditLog({
            event: "fill_failed", secret: name, origin: currentOrigin, session: sessionId,
            selectorKind: matchedPattern.label, error: (e as Error).message,
          });
          return err(`Fill failed: ${(e as Error).message}`);
        }
      }

      // --- Guardrail 5: audit log (success) ---
      auditLog({
        event: "fill_allowed", secret: name, origin: currentOrigin, session: sessionId,
        selectorKind: matchedPattern.label, gate: gateOutcome, pressEnter,
      });

      const gateExplain = FILL_GATE_EXPLAINED[gateOutcome];

      return ok(
        `Filled ${matchedPattern.label} on ${currentOrigin} with secret "${name}" [${gateExplain}]${verificationNote}. ` +
        `Length: ${value.length} chars. Value is NOT shown to you. ` +
        (pressEnter ? "Pressed Enter after fill. " : "") +
        `Take a new snapshot to see the next page state.`
      );
      });
      return withEmulationNotice(sessionId, "secret_fill", locked);
    },
  };
}
