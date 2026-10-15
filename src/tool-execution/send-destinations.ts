// Where a send delivers, for every tool whose arguments alone name it: the
// recipients of an email, the site a request goes to, a chat the user
// authorized, a fixed service. Two things read it: the private-content gate
// (private-content-destinations.ts), which adds the sends that need live state
// to name (the page the browser is on, the app under the cursor), and the
// approval cache, which keys an "always allow" on who receives the send
// (approval-decision.ts). Pure and synchronous: nothing here touches the
// device.

import { addressesIn } from "../data-lineage/private-content.js";

export type Destination =
  | { kind: "email"; address: string }
  | { kind: "site"; url: string; host: string }
  | { kind: "app"; name: string; title: string }
  | { kind: "service"; name: string }
  /** A messaging chat the tool may reach only because the user authorized it
   *  in Settings; an empty id is the owner's own configured chat. */
  | { kind: "chat"; app: "Telegram" | "WhatsApp"; id: string }
  | { kind: "unknown"; label: string };

/** The site a URL reaches; a bare host ("acme.com/apply") is read as https. */
export function siteOf(raw: unknown): Destination | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    const host = url.hostname.toLowerCase();
    return host ? { kind: "site", url: url.href, host } : null;
  } catch {
    return null; // not a URL: the caller names it as an address the check could not read
  }
}

export const unknownDestination = (label: string): Destination => ({ kind: "unknown", label });

/** Every recipient in these address fields. A field with an `@` the address
 *  pattern did not account for is a recipient the gate cannot name, so it
 *  counts as unknown rather than being dropped. */
function recipients(fields: unknown[]): Destination[] {
  const out: Destination[] = [];
  for (const f of fields) {
    if (typeof f !== "string" || !f.trim()) continue;
    const addrs = addressesIn(f);
    if (addrs.length === 0 || (f.match(/@/g) ?? []).length > addrs.length) out.push(unknownDestination("a recipient the check could not read"));
    out.push(...addrs.map((address): Destination => ({ kind: "email", address })));
  }
  return out;
}

type ArgsRule = (args: Record<string, unknown>) => Destination[];

const toUrl: ArgsRule = (args) => [siteOf(args.url) ?? unknownDestination("an address the check could not read")];
const toOnlyTheUser: ArgsRule = () => [];
const toService = (name: string): ArgsRule => () => [{ kind: "service", name }];
const toChat = (app: "Telegram" | "WhatsApp", arg: string): ArgsRule =>
  (args) => [{ kind: "chat", app, id: args[arg] == null ? "" : String(args[arg]).trim() }];

/** The sends whose destination is fully named by their arguments. */
export const DECLARED_DESTINATIONS: Readonly<Record<string, ArgsRule>> = {
  email_send: (args) => recipients([args.to, args.cc, args.bcc]),
  http_request: toUrl,
  ari_http: toUrl,
  web_fetch: toUrl,
  extract_site_assets: toUrl,
  youtube_analyze: toUrl,
  telegram_send: toChat("Telegram", "chat_id"),
  whatsapp_send: toChat("WhatsApp", "phone"),
  // The owner's own devices and clipboard.
  send_image: toOnlyTheUser,
  send_video: toOnlyTheUser,
  send_file: toOnlyTheUser,
  clipboard_write: toOnlyTheUser,
  web_search: toService("the web search engine"),
  image_search: toService("the web search engine"),
  generate_image: toService("the image generation service"),
  edit_image: toService("the image generation service"),
  generate_video: toService("the video generation service"),
  // Typed text lands in whatever app is on the device's screen, which the
  // check cannot name; open_url sends the URL to its site.
  android: (args) => String(args.action ?? "") === "open_url"
    ? [siteOf(args.url) ?? unknownDestination("an address the check could not read")]
    : [unknownDestination("the app on the Android device")],
};

/** Where this call delivers, when its arguments say; [] when it reaches only
 *  the user, null when naming it takes live state or the tool has no rule. */
export function declaredDestinations(toolName: string, args: Record<string, unknown>): Destination[] | null {
  return DECLARED_DESTINATIONS[toolName]?.(args) ?? null;
}

export function describeDestination(d: Destination): string {
  switch (d.kind) {
    case "email": return d.address;
    case "site": return d.host;
    case "app": return d.title ? `${d.name} ("${d.title.slice(0, 80)}")` : d.name;
    case "service": return d.name;
    case "chat": return d.id ? `${d.app} chat ${d.id}` : `your ${d.app} chat`;
    case "unknown": return d.label;
  }
}

/** What a remembered yes is keyed on: exactly what the card named, or null
 *  for a destination that cannot be named the same way twice. A site is its
 *  host and port, not its registrable domain: on a shared platform a sibling
 *  host (script.google.com beside docs.google.com) is someone else's tenant,
 *  and on one machine another port is another program. An app is never
 *  remembered: its window title is set by what is in the window (a page's own
 *  title, whatever runs in a terminal), so it cannot tell the form the user
 *  approved from an attacker's page or a later `curl`. An unknown destination
 *  may be somewhere else next time. */
export function destinationKey(d: Destination): string | null {
  switch (d.kind) {
    case "email": return `email:${d.address}`;
    case "site": return `site:${new URL(d.url).host}`;
    case "service": return `service:${d.name}`;
    case "chat": return `chat:${d.app}:${d.id}`;
    case "app":
    case "unknown": return null;
  }
}
