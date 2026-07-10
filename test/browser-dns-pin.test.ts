import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface FakeRequest {
  url: () => string;
  resourceType: () => string;
  isNavigationRequest: () => boolean;
}

type RouteHandler = (route: FakeRoute, request: FakeRequest) => Promise<void>;

async function captureGuard(): Promise<RouteHandler> {
  let handler: RouteHandler | undefined;
  const context = {
    route: vi.fn(async (_pattern: string, candidate: RouteHandler) => {
      handler = candidate;
    }),
  };
  await installRequestGuard(context as unknown as Parameters<typeof installRequestGuard>[0]);
  if (!handler) throw new Error("request guard did not register a route handler");
  return handler;
}

function fakeRoute(): FakeRoute {
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
  };
}

function navigationRequest(url: string): FakeRequest {
  return {
    url: () => url,
    resourceType: () => "document",
    isNavigationRequest: () => true,
  };
}

beforeEach(() => {
  resolve4.mockReset();
  resolve6.mockReset();
  resolve4.mockResolvedValue([]);
  resolve6.mockResolvedValue([]);
});

describe("installRequestGuard DNS enforcement", () => {
  it("fails closed when DNS resolution fails", async () => {
    const handler = await captureGuard();
    const route = fakeRoute();
    resolve4.mockRejectedValueOnce(new Error("DNS unavailable"));
    resolve6.mockRejectedValueOnce(new Error("DNS unavailable"));

    await handler(route, navigationRequest("https://unresolved.example/"));

    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("checks a redirect hop and aborts when it resolves to a private address", async () => {
    const handler = await captureGuard();
    resolve4.mockResolvedValueOnce(["93.184.216.34"]);
    const initialRoute = fakeRoute();

    await handler(initialRoute, navigationRequest("https://public.example/start"));

    expect(initialRoute.continue).toHaveBeenCalledOnce();
    expect(initialRoute.abort).not.toHaveBeenCalled();

    resolve4.mockResolvedValueOnce(["10.0.0.5"]);
    const redirectRoute = fakeRoute();
    await handler(redirectRoute, navigationRequest("https://redirect.example/internal"));

    expect(redirectRoute.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(redirectRoute.continue).not.toHaveBeenCalled();
  });
});
