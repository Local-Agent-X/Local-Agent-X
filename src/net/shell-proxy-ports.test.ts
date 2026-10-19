import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetShellProxyPortRange,
  machinePortRangeProbe,
  parseExcludedPortRanges,
  selectShellProxyPortRange,
  SHELL_PROXY_PORT_CANDIDATES,
  SHELL_PROXY_PORTS_ENV,
  shellProxyPortRange,
  shellProxyPortsOverride,
  ShellProxyPortsUnavailableError,
  type PortRange,
  type PortRangeProbe,
} from "./shell-proxy-ports.js";

// What `netsh int ipv4 show excludedportrange protocol=tcp` printed on a box
// with Hyper-V, WSL and Docker (2026-10-18): 60063-60162 swallows the first
// candidate whole.
const NETSH = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      1462        1462
     50000       50059     *
     59957       60056
     60063       60162
     64501       64600

* - Administered port exclusions.
`;

function probe(over: Partial<PortRangeProbe> & { persisted?: PortRange | null } = {}): PortRangeProbe & { netshCalls: number; persistedTo: PortRange[]; bound: string[] } {
  const p = {
    netshCalls: 0,
    persistedTo: [] as PortRange[],
    bound: [] as string[],
    platform: "win32" as NodeJS.Platform,
    excludedPortRanges: async () => { p.netshCalls++; return NETSH; },
    binds: async (r: PortRange) => { p.bound.push(`${r.from}-${r.to}`); return true; },
    readPersisted: () => over.persisted ?? null,
    persist: (r: PortRange) => { p.persistedTo.push(r); },
    ...over,
  };
  return p;
}

const [FIRST, SECOND, THIRD] = SHELL_PROXY_PORT_CANDIDATES;

describe("shell proxy port range — the choice", () => {
  it("reads the Windows reserved ranges from netsh's listing; an administered one (*) still binds, so it is not one", () => {
    expect(parseExcludedPortRanges(NETSH)).toEqual([
      { from: 1462, to: 1462 }, { from: 59957, to: 60056 }, { from: 60063, to: 60162 }, { from: 64501, to: 64600 },
    ]);
    expect(parseExcludedPortRanges("")).toEqual([]);
  });

  // Installing the cage reserves the proxy's range as an administered
  // exclusion. Read as taken, it would move the proxy off the very range the
  // reservation keeps for it, and the fence would permit a range nothing binds.
  it("keeps the range the cage reserved for it", async () => {
    const reservedForUs = `${NETSH.replace("     60063       60162\n", "")}     ${FIRST.from}       ${FIRST.to}     *\n`;
    const p = probe({ persisted: FIRST, excludedPortRanges: async () => reservedForUs });
    expect(await selectShellProxyPortRange(p)).toEqual(FIRST);
    expect(p.persistedTo).toEqual([]);
  });

  it("skips a candidate overlapping a Windows-reserved range without trying to bind it, and records the choice", async () => {
    const p = probe();
    expect(await selectShellProxyPortRange(p)).toEqual(SECOND);
    expect(p.bound).toEqual([`${SECOND.from}-${SECOND.to}`]);
    expect(p.persistedTo).toEqual([SECOND]);
  });

  it("skips a candidate in which nothing binds", async () => {
    const p = probe({ platform: "linux", binds: async (r) => r.from !== FIRST.from });
    expect(await selectShellProxyPortRange(p)).toEqual(SECOND);
    expect(p.netshCalls).toBe(0);
  });

  it("reuses the persisted choice while it still binds, without rewriting it", async () => {
    const p = probe({ persisted: THIRD });
    expect(await selectShellProxyPortRange(p)).toEqual(THIRD);
    expect(p.bound).toEqual([`${THIRD.from}-${THIRD.to}`]);
    expect(p.persistedTo).toEqual([]);
  });

  it("moves off a persisted choice Windows has since reserved, and records the new one", async () => {
    const p = probe({ persisted: { from: 60100, to: 60109 } });
    expect(await selectShellProxyPortRange(p)).toEqual(SECOND);
    expect(p.persistedTo).toEqual([SECOND]);
  });

  it("off Windows the selection is the same minus the netsh listing", async () => {
    const p = probe({ platform: "darwin" });
    expect(await selectShellProxyPortRange(p)).toEqual(FIRST);
    expect(p.netshCalls).toBe(0);
  });

  it("an unreadable netsh listing falls back to the bind probe alone", async () => {
    const p = probe({ excludedPortRanges: async () => { throw new Error("netsh missing"); } });
    expect(await selectShellProxyPortRange(p)).toEqual(FIRST);
  });

  it("no free range is an error naming every range tried and why, and the override that gets out of it", async () => {
    const p = probe({ binds: async () => false });
    const error = await selectShellProxyPortRange(p).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShellProxyPortsUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain(`${FIRST.from}-${FIRST.to} overlaps the range Windows reserved (60063-60162)`);
    for (const c of SHELL_PROXY_PORT_CANDIDATES.slice(1)) expect(message).toContain(`${c.from}-${c.to} has no port that binds`);
    expect(message).toContain(SHELL_PROXY_PORTS_ENV);
    expect(p.persistedTo).toEqual([]);
  });

  it("every candidate fits the Windows helper's permit cap and stays out of Anthropic's runtime range", () => {
    for (const c of SHELL_PROXY_PORT_CANDIDATES) {
      expect(c.to - c.from + 1).toBeLessThanOrEqual(50);
      expect(c.to < 60080 || c.from > 60089).toBe(true);
    }
  });
});

describe("shell proxy port range — the override", () => {
  it("parses from-to, ignores what is not a range, and refuses one the proxy cannot bind", () => {
    expect(shellProxyPortsOverride("61000-61003")).toEqual({ from: 61000, to: 61003 });
    expect(shellProxyPortsOverride("")).toBeNull();
    expect(shellProxyPortsOverride("nonsense")).toBeNull();
    expect(() => shellProxyPortsOverride("80-90")).toThrow(/1024/);
    expect(() => shellProxyPortsOverride("61010-61000")).toThrow(/from-to/);
  });

  describe("against a recorded choice", () => {
    const prev = { data: process.env.LAX_DATA_DIR, ports: process.env[SHELL_PROXY_PORTS_ENV] };
    let dataDir: string;
    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), "lax-proxy-ports-"));
      process.env.LAX_DATA_DIR = dataDir;
      _resetShellProxyPortRange();
    });
    afterEach(() => {
      if (prev.data === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev.data;
      if (prev.ports === undefined) delete process.env[SHELL_PROXY_PORTS_ENV]; else process.env[SHELL_PROXY_PORTS_ENV] = prev.ports;
      _resetShellProxyPortRange();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("wins over the persisted choice, and is read on every ask", async () => {
      writeFileSync(join(dataDir, "shell-proxy-ports.json"), JSON.stringify(THIRD));
      process.env[SHELL_PROXY_PORTS_ENV] = "61090-61099";
      expect(await shellProxyPortRange()).toEqual({ from: 61090, to: 61099 });
      process.env[SHELL_PROXY_PORTS_ENV] = "61100-61109";
      expect(await shellProxyPortRange()).toEqual({ from: 61100, to: 61109 });
      process.env[SHELL_PROXY_PORTS_ENV] = "80-90";
      await expect(shellProxyPortRange()).rejects.toThrow(/1024/);
    });
  });
});

describe("shell proxy port range — what the machine is asked", () => {
  const prev = process.env.LAX_DATA_DIR;
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-proxy-ports-"));
    process.env.LAX_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("the choice persists under the data dir and reads back next boot; a damaged record reads as none", () => {
    expect(machinePortRangeProbe.readPersisted()).toBeNull();
    machinePortRangeProbe.persist(SECOND);
    expect(JSON.parse(readFileSync(join(dataDir, "shell-proxy-ports.json"), "utf-8"))).toEqual(SECOND);
    expect(machinePortRangeProbe.readPersisted()).toEqual(SECOND);
    writeFileSync(join(dataDir, "shell-proxy-ports.json"), JSON.stringify({ from: 90, to: 99 }));
    expect(machinePortRangeProbe.readPersisted()).toBeNull();
    writeFileSync(join(dataDir, "shell-proxy-ports.json"), "{");
    expect(machinePortRangeProbe.readPersisted()).toBeNull();
  });

  it("a range binds while one of its ports is free, and not once every port is taken", async () => {
    const held: Server[] = [];
    const listen = (port: number) => new Promise<Server | null>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(null));
      s.listen(port, "127.0.0.1", () => resolve(s));
    });
    try {
      const first = await listen(0);
      expect(first).not.toBeNull();
      held.push(first!);
      const port = (first!.address() as { port: number }).port;
      expect(await machinePortRangeProbe.binds({ from: port, to: port })).toBe(false);
      const spare = await listen(0);
      held.push(spare!);
      const sparePort = (spare!.address() as { port: number }).port;
      await new Promise<void>((r) => spare!.close(() => r()));
      held.pop();
      expect(await machinePortRangeProbe.binds({ from: sparePort, to: sparePort })).toBe(true);
    } finally {
      await Promise.all(held.map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  });
});
