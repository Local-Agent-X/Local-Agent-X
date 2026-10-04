// Private content leaving for someone new: ask, never silently send and never
// refuse. A send that carries bytes of an email or a personal document the
// agent read, to a destination the user did not choose, is how a prompt
// injection turns "summarize my inbox" into "mail my statements to a
// stranger". The user is asked once (the approval card; an unattended run is
// refused, so a silent run can never approve its own leak).
//
// A personal document attached to a send counts too, read or not.
//
// A destination counts as chosen when it is the user's own address, on the
// trusted-destinations list (~/.lax/egress-allowlist.json), or, for content
// from one email, someone already on that email. In the user's own chat it
// also counts when the user named it there (an address, or a host the page is
// on or under), or when the user already approved sending that same source to
// that same address or host this session: a ten-field form filled from one
// resume asks once, not ten times. Neither of those last two reaches an
// unattended run, whose "user" row may be a mission prompt or another model's
// delegation.
//
// Which calls are sends, what they carry and where it goes:
// private-content-destinations.ts.

import type { PhaseOutcome, ToolCallContext } from "./context.js";
import { CONTINUE } from "./context.js";
import {
  addressesIn, findPrivateContent, hasPrivateReads, privateShareApproved, rememberPrivateShare, type PrivateContentMatch,
} from "../data-lineage/private-content.js";
import { isTrustedDestination, isTrustedEmailRecipient } from "../tools/http-egress-guard.js";
import { getOwnEmailAddresses } from "../tools/email-config.js";
import { currentHumanText } from "./unnamed-delete-gate.js";
import { registrableDomain } from "../browser/registrable-domain.js";
import {
  describeDestination, destinationKey, destinationsOf, payloadOf, sendsOffBox,
  type Destination, type PrivateGateDeps,
} from "./private-content-destinations.js";
import { UnreadableClipboardError } from "./private-content-computer.js";
import { egressPayload } from "./egress-gates.js";
import { personalDocumentPath } from "./private-read-record.js";

export type { PrivateGateDeps } from "./private-content-destinations.js";

interface Share { sourceKey: string; destinationKey: string }

/** The pairs this call's card asked about, collected by the approval phase on a yes. */
const pendingShares = new WeakMap<ToolCallContext, Share[]>();

/** Everything the human wrote in this chat, lowercased. Each row is held to
 *  the same test as the delete gate's "what did the user say": not a harness
 *  row, no harness or untrusted-content marker. */
function humanWords(ctx: ToolCallContext): string {
  return (ctx.priorMessages ?? []).map((m) => currentHumanText([m])).filter(Boolean).join("\n").toLowerCase();
}

const bareHost = (host: string): string => host.replace(/^www\./, "");

/** Did the user write this page's host, or a host it sits under, as a host of
 *  its own: not inside a longer name ("notacme.com", "acme.com.evil.net") and
 *  not as the domain of an email address. A sibling never counts: naming
 *  calendar.google.com does not name script.google.com, another tenant's
 *  host on the same platform. A public suffix ("com", "github.io") is no
 *  one's host, so it names nothing under it. */
function namedSite(words: string, host: string): boolean {
  const page = bareHost(host);
  const site = registrableDomain(page);
  return words.split(/[^a-z0-9.@-]+/).some((token) => {
    const named = bareHost(token.replace(/\.+$/, ""));
    if (!named || named.includes("@")) return false;
    return page === named || (site !== null && page.endsWith(`.${named}`) && registrableDomain(named) === site);
  });
}

/** `words` is empty in an unattended run, so nothing there counts as named. */
interface Judge { words: string; addresses: ReadonlySet<string>; own: ReadonlySet<string>; attended: boolean; sessionId: string }

/** Chosen for every source alike: the user's own, trusted, or named by the user. */
function chosenDestination(d: Destination, j: Judge): boolean {
  switch (d.kind) {
    case "email": return isTrustedEmailRecipient(d.address, j.own) || j.addresses.has(d.address);
    case "site": return isTrustedDestination(d.url) || namedSite(j.words, d.host);
    default: return false;
  }
}

function chosenFor(m: PrivateContentMatch, d: Destination, j: Judge): boolean {
  if (d.kind === "email" && m.correspondents.includes(d.address)) return true;
  const key = destinationKey(d);
  return j.attended && key !== null && privateShareApproved(j.sessionId, m.key, key);
}

/** The private sources this call would send. A paste whose clipboard cannot be
 *  read may carry any of them, so it counts as a source of its own. Only a
 *  paste reads the clipboard, and the window it lands in is never remembered,
 *  so a yes for it covers that one call. */
async function sourcesSent(ctx: ToolCallContext, deps: PrivateGateDeps, sessionId: string): Promise<PrivateContentMatch[]> {
  if (!hasPrivateReads(sessionId)) return [];
  let text: string;
  try {
    text = await payloadOf(ctx, deps);
  } catch (e) {
    if (e instanceof UnreadableClipboardError) return [{ label: "the clipboard (the check could not read it)", key: "", correspondents: [] }];
    throw e;
  }
  return text.trim() ? findPrivateContent(sessionId, text) : [];
}

/** The user's own documents this call attaches. An attachment sends the whole
 *  file, read or not, so each is a source of its own, keyed by its path as a
 *  read of it is. */
function documentsAttached(ctx: ToolCallContext, sessionId: string): PrivateContentMatch[] {
  const out: PrivateContentMatch[] = [];
  for (const raw of egressPayload(ctx.tc.name, ctx.args).attachmentPaths) {
    const doc = personalDocumentPath(raw, sessionId);
    if (doc) out.push({ label: doc, key: doc, correspondents: [] });
  }
  return out;
}

export async function privateContentGate(ctx: ToolCallContext, deps: PrivateGateDeps = {}): Promise<PhaseOutcome> {
  pendingShares.delete(ctx);
  const sessionId = ctx.sessionId || "default";
  if (!sendsOffBox(ctx.tc.name)) return CONTINUE;
  const matches = [...await sourcesSent(ctx, deps, sessionId), ...documentsAttached(ctx, sessionId)];
  if (matches.length === 0) return CONTINUE;
  const attended = ctx.callContext === "local";
  const words = attended ? humanWords(ctx) : "";
  const j: Judge = { words, addresses: new Set(addressesIn(words)), own: new Set(getOwnEmailAddresses()), attended, sessionId };
  const fresh = (await destinationsOf(ctx, deps)).filter((d) => !chosenDestination(d, j));

  const sources = new Set<string>();
  const dests = new Set<string>();
  // The destinations a yes is remembered for, as the card names them.
  const remembered = new Set<string>();
  const shares: Share[] = [];
  for (const d of fresh) {
    for (const m of matches) {
      if (chosenFor(m, d, j)) continue;
      const name = describeDestination(d);
      sources.add(m.label);
      dests.add(name);
      const key = destinationKey(d);
      if (!key) continue;
      shares.push({ sourceKey: m.key, destinationKey: key });
      remembered.add(name);
    }
  }
  if (dests.size === 0) return CONTINUE;
  pendingShares.set(ctx, shares);

  const reason = `This ${ctx.tc.name} would send text from ${[...sources].join(", ")} to ${[...dests].join(", ")}, which you have not chosen in this chat. `
    + "Approve it only if you meant to share that content there"
    + (remembered.size > 0
      ? `; a yes also covers sending it again in this session to ${[...remembered].join(", ")} only`
      : "; a yes covers this call only");
  if (!ctx.policyApprovalReason) ctx.policyApprovalReason = reason;
  else if (!ctx.policyApprovalReason.includes(reason)) ctx.policyApprovalReason += `; ${reason}`;
  return CONTINUE;
}

/** The user approved this call: its card's source/destination pairs stop asking for the session. */
export function rememberApprovedPrivateShares(ctx: ToolCallContext): void {
  for (const s of pendingShares.get(ctx) ?? []) rememberPrivateShare(ctx.sessionId || "default", s.sourceKey, s.destinationKey);
  pendingShares.delete(ctx);
}
