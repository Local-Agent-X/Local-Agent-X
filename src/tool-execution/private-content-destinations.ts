// What a send carries and where it would deliver it, for the private-content
// gate (private-content-gate.ts).
//
// Which tools are judged is derived from the tool policy: every egress-capable
// tool, every tool whose risk class is sending to a third party, and every
// tool whose row declares a destination (android, which the policy classes as
// shell) is a send; so is every MCP tool. A send whose row declares no
// destination delivers to "an unknown destination", which nobody has chosen,
// so a new sender asks until its row says where it goes; a destination can
// only make the gate quieter, by naming one the user can recognise or by
// saying the tool reaches only them.

import type { ToolCallContext } from "./context.js";
import { destinationSpecsOf, hasCapability, policyRowOf, type ToolRisk } from "../tool-registry.js";
import { classifyToolRisk } from "../autonomy/risk.js";
import { egressPayload } from "./egress-payload.js";
import { isLiveSpec, resolveSpec, siteOf, unknownDestination, type Destination } from "./send-destinations.js";
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

/** Is this tool a send the gate judges? An MCP tool hands its arguments to a
 *  program the user installed, which may send them anywhere; a tool the
 *  policy classes as shell but whose row says where it delivers (android) is
 *  a send by that declaration. */
export function sendsOffBox(toolName: string): boolean {
  return hasCapability(toolName, "egress")
    || THIRD_PARTY_RISKS.has(classifyToolRisk(toolName))
    || toolName.startsWith("mcp_")
    || policyRowOf(toolName)?.destination !== undefined;
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

/** Where this call would deliver its payload, as its row declares it;
 *  [] when it reaches only the user. */
export async function destinationsOf(ctx: ToolCallContext, deps: PrivateGateDeps): Promise<Destination[]> {
  if (ctx.tc.name.startsWith("mcp_")) return [{ kind: "service", name: `the MCP tool ${ctx.tc.name}` }];
  const specs = destinationSpecsOf(ctx.tc.name, ctx.args);
  if (!specs) return [UNKNOWN];
  const out: Destination[] = [];
  for (const spec of specs) {
    if (!isLiveSpec(spec)) out.push(...resolveSpec(spec, ctx.args));
    else out.push(...await (spec.to === "browser-page" ? browserDestinations(ctx, deps) : foregroundDestination(ctx, deps)));
  }
  return out;
}
