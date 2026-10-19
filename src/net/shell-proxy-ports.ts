// The loopback port range the shell egress proxy binds and the Windows cage
// permits. ONE decision, read by both through shellProxyPortRange(): the fence
// is configured before any shell runs, so the proxy has to live where the
// permit points, and a second copy of the range is a cage with no route out.
//
// Windows (Hyper-V, WSL, Docker) reserves TCP ranges out of its dynamic port
// range, in 100-port blocks that can move at every boot; a reserved port
// refuses to bind. So the range is chosen, not fixed: the first candidate that
// overlaps no reserved range and has a port that binds, preferring the range
// chosen last time, which is the one an installed cage permits.
// `LAX_SHELL_PROXY_PORTS=from-to` overrides the choice outright.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { atomicWriteFileSync, ensureDirFor } from "../util/json-store.js";
import { createLogger } from "../logger.js";

const logger = createLogger("net.shell-proxy-ports");

export interface PortRange { from: number; to: number }

export const SHELL_PROXY_PORTS_ENV = "LAX_SHELL_PROXY_PORTS";

/**
 * The ranges tried, in order. Ten ports each leave room for a second LAX
 * instance on the machine. The first is the range LAX has always used, just
 * above the one Anthropic's sandbox runtime uses by default (60080–60089) so
 * the two products never share a permit. The fallbacks sit below the dynamic
 * port range (49152–65535 by default), where Windows neither reserves blocks
 * nor hands out ephemeral ports, and clear of well-known services.
 */
export const SHELL_PROXY_PORT_CANDIDATES: readonly PortRange[] = [
  { from: 60090, to: 60099 },
  { from: 47090, to: 47099 },
  { from: 45090, to: 45099 },
  { from: 43090, to: 43099 },
];

function validRange(from: number, to: number): boolean {
  return Number.isInteger(from) && Number.isInteger(to) && from >= 1024 && to <= 65535 && from <= to;
}

/** The override, or null when unset or unparseable; a parseable range out of
 *  bounds throws, because a range the proxy cannot bind is never a choice. */
export function shellProxyPortsOverride(raw: string | undefined = process.env[SHELL_PROXY_PORTS_ENV]): PortRange | null {
  const m = raw ? /^(\d{1,5})-(\d{1,5})$/.exec(raw.trim()) : null;
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!validRange(from, to)) {
    throw new Error(`${SHELL_PROXY_PORTS_ENV} must be "from-to" with 1024 <= from <= to <= 65535, got "${raw}"`);
  }
  return { from, to };
}

/** The ranges in `netsh int ipv4 show excludedportrange protocol=tcp` output
 *  that refuse a bind. An administered exclusion (marked *) does not: it only
 *  keeps the range out of the blocks Windows hands out, and installing the
 *  cage puts the proxy's own range there (scripts/win-cage/provision.ps1). */
export function parseExcludedPortRanges(netshOutput: string): PortRange[] {
  const ranges: PortRange[] = [];
  for (const line of netshOutput.split(/\r?\n/)) {
    const m = /^\s*(\d{1,5})\s+(\d{1,5})\s*(\*)?\s*$/.exec(line);
    if (m && !m[3]) ranges.push({ from: Number(m[1]), to: Number(m[2]) });
  }
  return ranges;
}

function overlaps(a: PortRange, b: PortRange): boolean {
  return a.from <= b.to && b.from <= a.to;
}

function label(r: PortRange): string {
  return `${r.from}-${r.to}`;
}

/** What the selection asks of the machine; production defaults below, tests inject. */
export interface PortRangeProbe {
  platform: NodeJS.Platform;
  /** The excluded-range listing (Windows only; never called elsewhere). */
  excludedPortRanges(): Promise<string>;
  /** True when some port in the range binds on 127.0.0.1 right now. */
  binds(range: PortRange): Promise<boolean>;
  readPersisted(): PortRange | null;
  persist(range: PortRange): void;
}

export class ShellProxyPortsUnavailableError extends Error {
  constructor(tried: string[]) {
    super(
      `No loopback port range is free for the shell egress proxy, so caged shells have no network route: ${tried.join("; ")}. ` +
      `Free one of these ranges, or set ${SHELL_PROXY_PORTS_ENV}=from-to to a free range and restart.`,
    );
    this.name = "ShellProxyPortsUnavailableError";
  }
}

/** Pick the range: the persisted choice first, then the candidates, each
 *  skipped when it overlaps a Windows-reserved range or nothing in it binds. */
export async function selectShellProxyPortRange(probe: PortRangeProbe): Promise<PortRange> {
  let reserved: PortRange[] = [];
  if (probe.platform === "win32") {
    try {
      reserved = parseExcludedPortRanges(await probe.excludedPortRanges());
    } catch (e) {
      // The bind probe still refuses a reserved port; the listing only also
      // catches a range Windows has partly reserved.
      logger.warn(`could not read the Windows reserved port ranges; choosing by bind alone: ${(e as Error).message}`);
    }
  }
  const persisted = probe.readPersisted();
  const order = persisted ? [persisted, ...SHELL_PROXY_PORT_CANDIDATES.filter((c) => label(c) !== label(persisted))] : [...SHELL_PROXY_PORT_CANDIDATES];
  const tried: string[] = [];
  for (const range of order) {
    const clash = reserved.find((r) => overlaps(r, range));
    if (clash) { tried.push(`${label(range)} overlaps the range Windows reserved (${label(clash)})`); continue; }
    if (!(await probe.binds(range))) { tried.push(`${label(range)} has no port that binds`); continue; }
    if (!persisted || label(persisted) !== label(range)) {
      if (persisted) logger.warn(`shell egress proxy ports moved from ${label(persisted)} to ${label(range)} (${tried.join("; ")}); an installed Windows cage permits the old range until it is reinstalled`);
      probe.persist(range);
    }
    return range;
  }
  throw new ShellProxyPortsUnavailableError(tried);
}

function persistedPath(): string {
  return join(getLaxDir(), "shell-proxy-ports.json");
}

function bindsOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** The production probe: netsh, real loopback binds, the record under the data dir. */
export const machinePortRangeProbe: PortRangeProbe = {
  get platform() { return process.platform; },
  excludedPortRanges: () => new Promise((resolve, reject) => {
    execFile("netsh", ["int", "ipv4", "show", "excludedportrange", "protocol=tcp"], { encoding: "utf-8", timeout: 5_000, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  }),
  binds: async (range) => {
    for (let port = range.from; port <= range.to; port++) if (await bindsOnLoopback(port)) return true;
    return false;
  },
  readPersisted: () => {
    try {
      const { from, to } = JSON.parse(readFileSync(persistedPath(), "utf-8")) as Partial<PortRange>;
      return typeof from === "number" && typeof to === "number" && validRange(from, to) ? { from, to } : null;
    } catch {
      return null;
    }
  },
  persist: (range) => {
    const path = persistedPath();
    ensureDirFor(path);
    atomicWriteFileSync(path, JSON.stringify(range));
  },
};

let decided: Promise<PortRange> | null = null;

/**
 * The range the shell egress proxy binds and the Windows cage permits —
 * the one answer both read. Decided once per process (the server's boot-time
 * fence proof asks first, so it is settled before any shell runs) and reused;
 * a failed decision is retried on the next ask. The override is read per call.
 */
export function shellProxyPortRange(): Promise<PortRange> {
  try {
    const override = shellProxyPortsOverride();
    if (override) return Promise.resolve(override);
  } catch (e) {
    return Promise.reject(e);
  }
  if (!decided) {
    const deciding = selectShellProxyPortRange(machinePortRangeProbe);
    deciding.catch(() => { if (decided === deciding) decided = null; });
    decided = deciding;
  }
  return decided;
}

/** Tests: forget the decision. */
export function _resetShellProxyPortRange(): void {
  decided = null;
}
