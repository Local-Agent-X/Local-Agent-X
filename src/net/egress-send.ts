/**
 * The send-time judge (docs/proposals/egress-consolidation.md, phase 3): the
 * bytes the shared transport is about to put on the wire are judged before
 * each hop is dialed, on evidence only.
 *
 * The dispatch gate judged what the model wrote. This judges what the tool
 * actually sends, which can carry what the model never wrote: a file the tool
 * read and attached, a body it assembled, a secret it resolved. Refused:
 * the session's canary (proof of exfiltration), bytes from a sensitive source
 * the session read (positive overlap, never the presence floor), and a stored
 * secret's value the call was not approved to send. The URL and the body are
 * judged; headers are not, since a provider's key travels there by design and
 * the headers the model wrote were judged at dispatch. Mail is judged the same
 * way, on the composed message, before SMTP (assertMailSendAllowed).
 */
import type { FormData } from "undici";
import { findTaintInPayload } from "../data-lineage/index.js";
import { checkCanariesInPayload, recordCanaryExfilAudit } from "../threat/canaries.js";
import { scanKnownSecretValues } from "../security/secrets/index.js";
import { judgeEgress, type SendEgressState } from "./egress-judge.js";
import { egressSessionId } from "./egress-scope.js";

const LIVE: SendEgressState = {
  checkCanariesInPayload,
  findTaintInPayload,
  containsKnownSecretValue: (payload) => scanKnownSecretValues(payload).length > 0,
};

// A multipart file part past this is judged on its head: the scanners cap
// their own work at the same order of size (data-lineage SECRET_SCAN_CAP).
const PART_CAP = 256 * 1024;

/** What leaves: the URL plus every string field and file part of the body. */
async function payloadText(url: string, body: string | FormData | undefined): Promise<string> {
  if (body === undefined) return url;
  if (typeof body === "string") return `${url}\n${body}`;
  const parts: string[] = [url];
  for (const [name, value] of body.entries()) {
    parts.push(name, typeof value === "string" ? value : (await value.slice(0, PART_CAP).text()));
  }
  return parts.join("\n");
}

/** A request refused at send. The reason names what fired and the host, never
 *  the bytes; `layer` and `clearable` let a tool render the block's exit. */
export class EgressPayloadBlocked extends Error {
  constructor(
    message: string,
    readonly layer: "canary" | "data-lineage" | "egress-guard",
    readonly clearable?: "declassify",
  ) {
    super(message);
    this.name = "EgressPayloadBlocked";
  }
}

/** Throw EgressPayloadBlocked when the bytes about to be sent carry evidence.
 *  `approvedSecretValues` are the secrets this call was cleared to send there
 *  (http_request's placeholders); they are removed before judging. */
export async function assertSendAllowed(url: string, body: string | FormData | undefined, approvedSecretValues: readonly string[] = []): Promise<void> {
  let host = "an external host";
  try { host = new URL(url).host; } catch { /* the transport refuses an unparseable URL first */ }
  judgeOrThrow(await payloadText(url, body), `the request to ${host}`, approvedSecretValues);
}

/** The same judgement for a composed email, before it is handed to SMTP:
 *  envelope, subject, bodies and every attachment's bytes (each judged on its
 *  head, like a multipart file part). */
export function assertMailSendAllowed(recipients: string, parts: ReadonlyArray<string | Uint8Array>): void {
  const text = parts.map((p) => typeof p === "string" ? p : Buffer.from(p.subarray(0, PART_CAP)).toString("utf8")).join("\n");
  judgeOrThrow(text, `the email to ${recipients}`, []);
}

function judgeOrThrow(payload: string, what: string, approvedSecretValues: readonly string[]): void {
  let text = payload;
  for (const value of approvedSecretValues) if (value) text = text.split(value).join("");
  const sessionId = egressSessionId() ?? "";
  const judged = judgeEgress(LIVE, "tool-send", sessionId, text);
  if (judged.canary) {
    recordCanaryExfilAudit(sessionId, "network-send");
    throw new EgressPayloadBlocked(`Blocked at send: ${what} carries this session's canary token — definitive exfiltration of protected context. Nothing was sent, and the attempt was recorded.`, "canary");
  }
  if (judged.knownSecret) {
    throw new EgressPayloadBlocked(`Blocked at send: ${what} carries a stored secret's value that this call was not approved to send. Nothing was sent. To send a stored secret, use http_request with a {{SECRET_NAME}} placeholder so the user approves where it goes.`, "egress-guard");
  }
  if (judged.taint) {
    const named = [...new Set(judged.taint.sources.map((t) => `${t.source}:${t.target.slice(0, 40)}`))].join(", ");
    throw new EgressPayloadBlocked(`Blocked at send: ${what} carries bytes from a sensitive source this session read (${named}). Nothing was sent. Leave that content out, or ask the user to click "Declassify & retry" on this card if sending it is intended.`, "data-lineage", "declassify");
  }
}
