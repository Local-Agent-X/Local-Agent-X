// What a send carries and where it would deliver it, for the private-content
// gate (private-content-gate.ts).
//
// Which tools are judged is derived from the tool policy: every egress-capable
// tool, and every tool whose risk class is sending to a third party, is a
// send. The exceptions the policy classes as shell are named below (MCP
// tools, android). A send with no rule below delivers to
// "an unknown destination", which nobody has chosen, so a new sender asks
// until it gets a rule; a rule can only make the gate quieter, by naming a
// destination the user can recognise or by saying the tool reaches only them.

import type { ToolCallContext } from "./context.js";
import { hasCapability, type ToolRisk } from "../tool-registry.js";
import { classifyToolRisk } from "../autonomy/risk.js";
import { egressPayload } from "./egress-gates.js";
import { addressesIn } from "../data-lineage/private-content.js";
import { computerPayload, queryForegroundApp, readClipboardText, type ForegroundApp } from "./private-content-computer.js";

export type Destination =
  | { kind: "email"; address: string }
  | { kind: "site"; url: string; host: string }
  | { kind: "app"; name: string; title: string }
  | { kind: "service"; name: string }
  | { kind: "unknown"; label: string };

export interface PrivateGateDeps {
  /** The page the session's browser is on, for a browser write. */
  browserCurrentUrl?: (sessionId: string) => Promise<string>;
  /** The desktop app a `computer` keystroke lands in. */
  foregroundApp?: () => Promise<ForegroundApp | null>;
  /** What a paste chord would paste. */
  clipboardText?: () => Promise<string>;
}

const THIRD_PARTY_RISKS: ReadonlySet<ToolRisk> = new Set(["external-comms", "network-write"]);

/** Senders the policy classes as shell, not egress: an MCP tool hands its
 *  arguments to a program the user installed, which may send them anywhere,
 *  and the android tool types into apps and opens URLs on a device. Their
 *  risk class also drives approval cards under each profile, so it stays. */
const SHELL_CLASSED_SENDERS: ReadonlySet<string> = new Set(["android"]);

/** Is this tool a send the gate judges? */
export function sendsOffBox(toolName: string): boolean {
  return hasCapability(toolName, "egress")
    || THIRD_PARTY_RISKS.has(classifyToolRisk(toolName))
    || toolName.startsWith("mcp_")
    || SHELL_CLASSED_SENDERS.has(toolName);
}

/** Every string in a value, however deeply nested. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** The text this call would send. An MCP tool's arguments have no fixed
 *  names (a title, a message, a channel), so all of them are its payload. */
export async function payloadOf(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<string> {
  if (ctx.tc.name === "computer") return computerPayload(ctx.args, deps.clipboardText ?? readClipboardText);
  if (ctx.tc.name.startsWith("mcp_")) return stringsIn(ctx.args).join("\n");
  return egressPayload(ctx.tc.name, ctx.args).text;
}

async function defaultBrowserCurrentUrl(sessionId: string): Promise<string> {
  try {
    const { getBrowserManager } = await import("../browser/instance.js");
    return await getBrowserManager(sessionId).getCurrentUrl();
  } catch {
    return ""; // no browser for this session: the page is unknown, and the gate says so
  }
}

/** The site a URL reaches; a bare host ("acme.com/apply") is read as https. */
function siteOf(raw: unknown): Destination | null {
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

const unknown = (label: string): Destination => ({ kind: "unknown", label });
const UNKNOWN = unknown("an unknown destination");

/** Every recipient in these address fields. A field with an `@` the address
 *  pattern did not account for is a recipient the gate cannot name, so it
 *  counts as unknown rather than being dropped. */
function recipients(fields: unknown[]): Destination[] {
  const out: Destination[] = [];
  for (const f of fields) {
    if (typeof f !== "string" || !f.trim()) continue;
    const addrs = addressesIn(f);
    if (addrs.length === 0 || (f.match(/@/g) ?? []).length > addrs.length) out.push(unknown("a recipient the check could not read"));
    out.push(...addrs.map((address): Destination => ({ kind: "email", address })));
  }
  return out;
}

type Rule = (ctx: ToolCallContext, deps: PrivateGateDeps) => Destination[] | Promise<Destination[]>;

const toUrl: Rule = (ctx) => [siteOf(ctx.args.url) ?? unknown("an address the check could not read")];
const toOnlyTheUser: Rule = () => [];
const toService = (name: string): Rule => () => [{ kind: "service", name }];

const LEAVES_THE_PAGE: ReadonlySet<string> = new Set(["navigate", "new_tab"]);

async function browserDestinations(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  const named = [ctx.args.url, ...(Array.isArray(ctx.args.urls) ? ctx.args.urls : [])].filter((u) => typeof u === "string" && u);
  const out = named.map((u) => siteOf(u) ?? unknown("an address the check could not read"));
  // Anything but a navigation acts on the open page, whatever URL its args
  // name: a fill handed a url the user named still types into the page it is on.
  if (named.length === 0 || !LEAVES_THE_PAGE.has(String(ctx.args.action ?? "").toLowerCase())) {
    const page = await (deps.browserCurrentUrl ?? defaultBrowserCurrentUrl)(ctx.sessionId || "default");
    out.push(siteOf(page) ?? unknown("the page the browser is on"));
  }
  return out;
}

async function foregroundDestination(_ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  const app = await (deps.foregroundApp ?? queryForegroundApp)();
  return [app ? { kind: "app", name: app.name, title: app.title } : UNKNOWN];
}

/** Exported for the contract test: every rule must belong to a judged tool. */
export const DESTINATION_RULES: Readonly<Record<string, Rule>> = {
  email_send: (ctx) => recipients([ctx.args.to, ctx.args.cc, ctx.args.bcc]),
  // An event with no attendees stays on the user's own calendar.
  calendar_create_event: (ctx) => recipients([ctx.args.attendees]),
  http_request: toUrl,
  ari_http: toUrl,
  web_fetch: toUrl,
  extract_site_assets: toUrl,
  youtube_analyze: toUrl,
  browser: browserDestinations,
  computer: foregroundDestination,
  // The owner's own chats, devices and clipboard.
  telegram_send: toOnlyTheUser,
  whatsapp_send: toOnlyTheUser,
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
  android: (ctx) => String(ctx.args.action ?? "") === "open_url"
    ? [siteOf(ctx.args.url) ?? unknown("an address the check could not read")]
    : [unknown("the app on the Android device")],
};

/** Where this call would deliver its payload; [] when it reaches only the user. */
export async function destinationsOf(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  if (ctx.tc.name.startsWith("mcp_")) return [{ kind: "service", name: `the MCP tool ${ctx.tc.name}` }];
  const rule = DESTINATION_RULES[ctx.tc.name];
  return rule ? rule(ctx, deps) : [UNKNOWN];
}

export function describeDestination(d: Destination): string {
  switch (d.kind) {
    case "email": return d.address;
    case "site": return d.host;
    case "app": return d.title ? `${d.name} ("${d.title.slice(0, 80)}")` : d.name;
    case "service": return d.name;
    case "unknown": return d.label;
  }
}

/** What a remembered yes is keyed on: exactly what the card named, or null
 *  for a destination that cannot be named the same way twice. A site is its
 *  host, not its registrable domain: on a shared platform a sibling host
 *  (script.google.com beside docs.google.com) is someone else's tenant. An
 *  app is never remembered: its window title is set by what is in the window
 *  (a page's own title, whatever runs in a terminal), so it cannot tell the
 *  form the user approved from an attacker's page or a later `curl`. An
 *  unknown destination may be somewhere else next time. */
export function destinationKey(d: Destination): string | null {
  switch (d.kind) {
    case "email": return `email:${d.address}`;
    case "site": return `site:${d.host}`;
    case "service": return `service:${d.name}`;
    case "app":
    case "unknown": return null;
  }
}
