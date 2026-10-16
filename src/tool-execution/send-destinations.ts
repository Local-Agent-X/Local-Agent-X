// Where a send delivers, resolved from its policy row's `destination` for
// every spec its arguments alone name: the recipients of an email, the site a
// request goes to, a chat the user authorized, a fixed service. Two things
// read it: the private-content gate (private-content-destinations.ts), which
// resolves the live-state specs too (the page the browser is on, the app
// under the cursor), and the approval cache, which keys an "always allow" on
// who receives the send (approval-decision.ts). Pure and synchronous: nothing
// here touches the device.

import { addressesIn } from "../data-lineage/private-content.js";
import { destinationSpecsOf } from "../tool-registry.js";
import type { DestinationSpec } from "../tool-policy/tool-policies.types.js";

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

/** A destination spec whose arguments alone name where it delivers. */
export type ArgsNamedSpec = Exclude<DestinationSpec, { to: "browser-page" } | { to: "foreground-app" }>;

/** Names live state rather than arguments: the open page, the foreground app. */
export const isLiveSpec = (spec: DestinationSpec): spec is Exclude<DestinationSpec, ArgsNamedSpec> =>
  spec.to === "browser-page" || spec.to === "foreground-app";

/** Where one args-named spec delivers this call; [] when it reaches only the user. */
export function resolveSpec(spec: ArgsNamedSpec, args: Record<string, unknown>): Destination[] {
  switch (spec.to) {
    case "site": return [siteOf(args[spec.arg]) ?? unknownDestination("an address the check could not read")];
    case "recipients": return recipients(spec.args.map((a) => args[a]));
    case "chat": return [{ kind: "chat", app: spec.app, id: args[spec.arg] == null ? "" : String(args[spec.arg]).trim() }];
    case "user": return [];
    case "service": return [{ kind: "service", name: spec.name }];
    case "unknown": return [unknownDestination(spec.label)];
  }
}

/** Where this call delivers, when its arguments say (its row's destination);
 *  [] when it reaches only the user, null when naming it takes live state or
 *  the row declares none. */
export function declaredDestinations(toolName: string, args: Record<string, unknown>): Destination[] | null {
  const specs = destinationSpecsOf(toolName, args);
  if (!specs || specs.some(isLiveSpec)) return null;
  return (specs as readonly ArgsNamedSpec[]).flatMap((s) => resolveSpec(s, args));
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
