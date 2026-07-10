import { describe, it, expect, vi, beforeEach } from "vitest";

// The legacy per-call DNS pre-check (dnsPinCheck) was removed: it only gated
// the INITIAL navigate/new_tab URL and failed OPEN on DNS errors. The
// context-level request guard (installRequestGuard) is the single canonical
// browser URL guard — it runs on every navigation request, per redirect hop,
// and fails CLOSED. These tests assert the guard blocks everything the old
// pre-check used to screen, so coverage does not regress.
//
// The guard delegates to validateUrlWithDns (network-policy), which resolves
// hostnames via node:dns promises. Mock the resolver so hostname cases are
// deterministic and offline; literal-IP cases never touch DNS.
const resolve4 = vi.fn<(host: string) => Promise<string[]>>();
const resolve6 = vi.fn<(host: string) => Promise<string[]>>();

vi.mock("node:dns", () => ({
  promises: {
    resolve4: (host: string) => resolve4(host),
    resolve6: (host: string) => resolve6(host),
  },
}));

import { installRequestGuard } from "../src/browser/guards.js";

interface FakeRoute {
  abort: ReturnType<typeof vi.fn>;
  continue: ReturnType<typeof vi.fn>;
}

function fakeRoute(): FakeRoute {
  return { abort: vi.fn().mockResolvedValue(undefined), continue: vi.fn().mockResolvedValue(undefined) };
}

function navRequest(url: string) {
  return {
    url: () => url,
    resourceType: () => "document",
    isNavigationRequest: () => true,
  };
}

type RouteHandler = (route: FakeRoute, request: ReturnType<typeof navRequest>) => Promise<void>;

async function captureGuard(): Promise<RouteHandler> {
  let handler: RouteHandler | undefined;
  const fakeContext = {
    route: vi.fn(async (_pattern: string, h: RouteHandler) => { handler = h; }),
  };
  // Fresh context object per call, so the install-once WeakSet never
  // short-circuits between tests.
  await installRequestGuard(fakeContext as unknown as Parameters<typeof installRequestGuard>[0]);
  if (!handler) throw new Error("guard did not register a route handler");
  return handler;
}

async function driveNav(url: string): Promise<FakeRoute> {
  const handler = await captureGuard();
  const route = fakeRoute();
  await handler(route, navRequest(url));
  return route;
}

function expectBlocked(route: FakeRoute): void {
  expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
  expect(route.continue).not.toHaveBeenCalled();
}

function expectAllowed(route: FakeRoute): void {
  expect(route.continue).toHaveBeenCalled();
  expect(route.abort).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  resolve4.mockResolvedValue([]);
  resolve6.mockResolvedValue([]);
});

describe("installRequestGuard — private-IP / DNS-rebinding navigation coverage", () => {
  it("aborts a navigation to a literal private IPv4 (192.168.x)", async () => {
    expectBlocked(await driveNav("http://192.168.1.1/"));
  });

  it("aborts a navigation to a literal 10.x address", async () => {
    expectBlocked(await driveNav("http://10.0.0.5/"));
  });

  it("aborts a navigation to literal fe80::1 (link-local)", async () => {
    expectBlocked(await driveNav("http://[fe80::1]/"));
  });

  it("aborts a navigation to literal fd12::1 (ULA)", async () => {
    expectBlocked(await driveNav("http://[fd12::1]/"));
  });

  it("aborts a navigation to IPv4-mapped ::ffff:192.168.1.1", async () => {
    expectBlocked(await driveNav("http://[::ffff:192.168.1.1]/"));
  });

  it("aborts when a hostname's A record is 10.x (DNS rebinding)", async () => {
    resolve4.mockResolvedValue(["10.0.0.5"]);
    expectBlocked(await driveNav("https://evil.example.com/"));
  });

  it("aborts when a hostname's AAAA record is a ULA address (DNS rebinding)", async () => {
    resolve6.mockResolvedValue(["fd00::dead:beef"]);
    expectBlocked(await driveNav("https://evil.example.com/"));
  });

  it("aborts a navigation when DNS resolution fails entirely (fail-closed, unlike the old pre-check)", async () => {
    // resolve4/resolve6 both return [] from beforeEach — no A/AAAA records.
    expectBlocked(await driveNav("https://no-such-host.example.com/"));
  });

  it("allows a navigation to a hostname resolving only to public addresses", async () => {
    resolve4.mockResolvedValue(["93.184.216.34"]);
    resolve6.mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]);
    expectAllowed(await driveNav("https://example.com/"));
  });

  it("allows a navigation to a literal public IPv6 address", async () => {
    expectAllowed(await driveNav("http://[2606:4700:4700::1111]/"));
  });
});
