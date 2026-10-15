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
import { egressPayload } from "./egress-payload.js";
import { DECLARED_DESTINATIONS, siteOf, unknownDestination, type Destination } from "./send-destinations.js";
import { computerPayload, queryForegroundApp, readClipboardText, type ForegroundApp } from "./private-content-computer.js";

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

type Rule = (ctx: ToolCallContext, deps: PrivateGateDeps) => Destination[] | Promise<Destination[]>;

const UNKNOWN = unknownDestination("an unknown destination");

const LEAVES_THE_PAGE: ReadonlySet<string> = new Set(["navigate", "new_tab"]);

async function browserDestinations(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  const named = [ctx.args.url, ...(Array.isArray(ctx.args.urls) ? ctx.args.urls : [])].filter((u) => typeof u === "string" && u);
  const out = named.map((u) => siteOf(u) ?? unknownDestination("an address the check could not read"));
  // Anything but a navigation acts on the open page, whatever URL its args
  // name: a fill handed a url the user named still types into the page it is on.
  if (named.length === 0 || !LEAVES_THE_PAGE.has(String(ctx.args.action ?? "").toLowerCase())) {
    const page = await (deps.browserCurrentUrl ?? defaultBrowserCurrentUrl)(ctx.sessionId || "default");
    out.push(siteOf(page) ?? unknownDestination("the page the browser is on"));
  }
  return out;
}

async function foregroundDestination(_ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  const app = await (deps.foregroundApp ?? queryForegroundApp)();
  return [app ? { kind: "app", name: app.name, title: app.title } : UNKNOWN];
}

/** Exported for the contract test: every rule must belong to a judged tool.
 *  The sends whose arguments name their destination are declared in
 *  send-destinations.ts; the two here need the session's live state. */
export const DESTINATION_RULES: Readonly<Record<string, Rule>> = {
  ...Object.fromEntries(Object.entries(DECLARED_DESTINATIONS).map(([name, rule]): [string, Rule] => [name, (ctx) => rule(ctx.args)])),
  browser: browserDestinations,
  computer: foregroundDestination,
};

/** Where this call would deliver its payload; [] when it reaches only the user. */
export async function destinationsOf(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  if (ctx.tc.name.startsWith("mcp_")) return [{ kind: "service", name: `the MCP tool ${ctx.tc.name}` }];
  const rule = DESTINATION_RULES[ctx.tc.name];
  return rule ? rule(ctx, deps) : [UNKNOWN];
}
