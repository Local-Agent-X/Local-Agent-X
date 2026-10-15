// What an egress-class call carries off the box. One extraction feeds every
// outbound judgment: the secret scan, the taint floor and the canary tripwire
// (egress-gates.ts), the kernel's taint scope (taint-scope.ts) and the
// private-content gate.
//
// Every value the model wrote is payload, whatever the argument is called and
// whichever tool it was handed to. The only arguments left out are the ones
// named in LOCAL_CONTROL_ARGS, which steer the tool on this machine and never
// leave it. A tool or argument nobody thought about is therefore scanned in
// full: forgetting one fails closed, where a list of the arguments to read
// failed open for every egress tool it did not name.

import { isInternalArgKey } from "./internal-args.js";

/**
 * Arguments that address or steer a tool locally and carry nothing anywhere:
 * which action, which element, where the pointer goes, which keys make a
 * chord. They are not payload because a click or a mouse move must read as
 * carrying nothing; otherwise the taint floor blocks the pointer after any
 * sensitive read, and the kernel's taint scope can no longer clear a click.
 * Each entry must name a parameter the tool declares (egress-payload.test.ts).
 */
export const LOCAL_CONTROL_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  // The element a click or fill acts on; the page never receives the ref or selector.
  browser: new Set(["action", "ref", "selector"]),
  // Only typed `text` reaches the other app as data.
  computer: new Set(["action", "x", "y", "from_x", "from_y", "to_x", "to_y", "button", "target", "keys"]),
};

// Remote http(s)/data: references aren't local-file reads.
const isLocalFileRef = (v: unknown): v is string => typeof v === "string" && v !== "" && !/^(https?:|data:)/i.test(v);

// Arguments that name a LOCAL file whose bytes the sink ships off-box
// (generate_video reference images, edit_image source and mask, send_video
// path, ...). They go to the sensitive-attachment check as well as the text.
const LOCAL_FILE_ARGS = ["reference_image", "reference_images", "image", "mask", "path"] as const;

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
  const local = LOCAL_CONTROL_ARGS[name];
  for (const [key, value] of Object.entries(args)) {
    if (isInternalArgKey(key) || local?.has(key)) continue;
    collect(value, parts);
  }

  const attachmentPaths: string[] = [];
  if (name === "email_send" && args.attachments) {
    try {
      const paths = JSON.parse(String(args.attachments));
      if (Array.isArray(paths)) for (const p of paths) attachmentPaths.push(String(p));
    } catch { /* malformed attachments JSON — the tool will reject it */ }
  }
  for (const arg of LOCAL_FILE_ARGS) {
    const v = args[arg];
    for (const ref of Array.isArray(v) ? v : [v]) if (isLocalFileRef(ref)) attachmentPaths.push(ref);
  }
  return { text: parts.join("\n"), attachmentPaths };
}
