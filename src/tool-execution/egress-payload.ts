// What an egress-class call carries off the box. One extraction feeds every
// outbound judgment: the secret scan, the taint floor and the canary tripwire
// (egress-gates.ts), the kernel's taint scope (taint-scope.ts) and the
// private-content gate.
//
// Every value the model wrote is payload, whatever the argument is called and
// whichever tool it was handed to. The only arguments left out are the ones
// the tool's row names as `localArgs`, which steer the tool on this machine
// and never leave it: which action, which element, where the pointer goes,
// which keys make a chord. A click or a mouse move must read as carrying
// nothing, or the taint floor blocks the pointer after any sensitive read and
// the kernel's taint scope can no longer clear a click. A tool or argument
// nobody thought about is scanned in full: forgetting one fails closed, where
// a list of the arguments to read failed open for every egress tool it did
// not name.

import { isInternalArgKey } from "./internal-args.js";
import { callPaths, localArgsOf } from "../tool-registry.js";

// Remote http(s)/data: references aren't local-file reads.
const isLocalFileRef = (v: unknown): v is string => typeof v === "string" && v !== "" && !/^(https?:|data:)/i.test(v);

/** Every string and number in a value, object keys included: a header name or
 *  an env var name leaves with its value. Booleans carry nothing to scan. */
function collect(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    if (value !== "") parts.push(value);
  } else if (typeof value === "number" || typeof value === "bigint") {
    parts.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, parts);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      parts.push(k);
      collect(v, parts);
    }
  }
}

/** The outbound text of an egress-class call, plus the local files it would
 *  attach. Server-stamped `_` arguments are the server's, not the model's,
 *  and are never payload. */
export function egressPayload(name: string, args: Record<string, unknown>): { text: string; attachmentPaths: string[] } {
  const parts: string[] = [];
  const local = localArgsOf(name);
  for (const [key, value] of Object.entries(args)) {
    if (isInternalArgKey(key) || local.includes(key)) continue;
    collect(value, parts);
  }

  // The local files it ships are the paths its policy row says the call reads
  // (email_send attachments, generate_video reference images, edit_image
  // source and mask, send_video path, ...): they go to the sensitive-attachment
  // check as well as the text.
  const attachmentPaths = callPaths(name, args).reads.filter(isLocalFileRef);
  return { text: parts.join("\n"), attachmentPaths };
}
