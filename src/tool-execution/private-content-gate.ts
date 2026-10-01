// Private content leaving for someone new: ask, never silently send and never
// refuse. A send that carries bytes of an email or a personal document the
// agent read, to a destination the user did not choose, is how a prompt
// injection turns "summarize my inbox" into "mail my statements to a
// stranger". The user is asked once (the approval card; an unattended run is
// refused, so a silent run can never approve its own leak).
//
// A destination counts as chosen when it is the user's own address, on the
// trusted-destinations list (~/.lax/egress-allowlist.json), named by the user
// in this chat, or, for content from one email, someone already on that
// email. Everything else is new.

import type { PhaseOutcome, ToolCallContext } from "./context.js";
import { CONTINUE } from "./context.js";
import { egressPayload } from "./egress-gates.js";
import { findPrivateContent, type PrivateContentMatch } from "../data-lineage/private-content.js";
import { isTrustedDestination, isTrustedEmailRecipient, parseRecipientAddresses } from "../tools/http-egress-guard.js";
import { getOwnEmailAddresses } from "../tools/email-config.js";
import { BROWSER_WRITE_ACTIONS } from "./ari-action-map.js";

type Destination = { kind: "email"; address: string } | { kind: "url"; url: string; host: string } | { kind: "unknown"; label: string };

export interface PrivateGateDeps {
  /** The page the session's browser is on, for a browser write. */
  browserCurrentUrl?: (sessionId: string) => Promise<string>;
}

async function defaultBrowserCurrentUrl(sessionId: string): Promise<string> {
  try {
    const { getBrowserManager } = await import("../browser/instance.js");
    return await getBrowserManager(sessionId).getCurrentUrl();
  } catch {
    return "";
  }
}

function urlDestination(raw: unknown): Destination | null {
  if (typeof raw !== "string" || !raw) return null;
  try { return { kind: "url", url: raw, host: new URL(raw).hostname.toLowerCase() }; } catch { return null; }
}

/** Where this call would send its payload, or null when the tool is not a third-party channel. */
async function destinationsOf(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[] | null> {
  const a = ctx.args;
  switch (ctx.tc.name) {
    case "email_send":
      return parseRecipientAddresses([a.to, a.cc, a.bcc].filter(Boolean).join(",")).map((address) => ({ kind: "email", address }));
    case "calendar_create_event":
      return parseRecipientAddresses(String(a.attendees ?? "")).map((address) => ({ kind: "email", address }));
    case "http_request":
    case "ari_http":
    case "web_fetch": {
      const d = urlDestination(a.url);
      return [d ?? { kind: "unknown", label: "an unparseable address" }];
    }
    case "browser": {
      const action = String(a.action ?? "").toLowerCase();
      if (action === "navigate" || action === "new_tab") {
        const urls = Array.isArray(a.urls) ? a.urls : [a.url];
        return urls.map(urlDestination).filter((d): d is Destination => d !== null);
      }
      if (!BROWSER_WRITE_ACTIONS.has(action)) return null;
      const d = urlDestination(await (deps.browserCurrentUrl ?? defaultBrowserCurrentUrl)(ctx.sessionId || "default"));
      return [d ?? { kind: "unknown", label: "the page the browser is on" }];
    }
    default:
      return null;
  }
}

/** Everything the user wrote in this chat, lowercased: a destination they named is one they chose. */
function userWords(ctx: ToolCallContext): string {
  const parts: string[] = [];
  for (const m of ctx.msgs ?? []) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) for (const p of m.content) if (p && typeof p === "object" && "text" in p && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n").toLowerCase();
}

function isChosen(d: Destination, matches: readonly PrivateContentMatch[], words: string, own: ReadonlySet<string>): boolean {
  if (d.kind === "unknown") return false;
  if (d.kind === "email") {
    return isTrustedEmailRecipient(d.address, own)
      || words.includes(d.address)
      || matches.some((m) => m.correspondents.includes(d.address));
  }
  return isTrustedDestination(d.url) || (!!d.host && words.includes(d.host.replace(/^www\./, "")));
}

function describe(d: Destination): string {
  return d.kind === "email" ? d.address : d.kind === "url" ? d.host : d.label;
}

export async function privateContentGate(ctx: ToolCallContext, deps: PrivateGateDeps = {}): Promise<PhaseOutcome> {
  const { text } = egressPayload(ctx.tc.name, ctx.args);
  if (!text.trim()) return CONTINUE;
  const matches = findPrivateContent(ctx.sessionId || "default", text);
  if (matches.length === 0) return CONTINUE;
  const dests = await destinationsOf(ctx, deps);
  if (!dests) return CONTINUE;
  const words = userWords(ctx);
  const own = new Set(getOwnEmailAddresses());
  const fresh = dests.filter((d) => !isChosen(d, matches, words, own));
  if (fresh.length === 0) return CONTINUE;
  const sources = [...new Set(matches.map((m) => m.target))].join(", ");
  const reason = `This ${ctx.tc.name} would send text from ${sources} to ${fresh.map(describe).join(", ")}, which you have not named in this chat. `
    + "Approve it only if you meant to share that content there.";
  if (!ctx.policyApprovalReason) ctx.policyApprovalReason = reason;
  else if (!ctx.policyApprovalReason.includes(reason)) ctx.policyApprovalReason += `; ${reason}`;
  return CONTINUE;
}
