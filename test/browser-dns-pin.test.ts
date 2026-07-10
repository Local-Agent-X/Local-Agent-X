import { beforeEach, describe, expect, it, vi } from "vitest";

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
  vi.clearAllMocks();
});

describe("installRequestGuard URL policy", () => {
  it("fails closed on a private literal before proxy dispatch", async () => {
    const handler = await captureGuard();
    const route = fakeRoute();

    await handler(route, navigationRequest("https://10.0.0.7/"));

    expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(route.continue).not.toHaveBeenCalled();
  });

  it("checks a redirect hop and aborts a metadata target", async () => {
    const handler = await captureGuard();
    const initialRoute = fakeRoute();

    await handler(initialRoute, navigationRequest("https://93.184.216.34/start"));

    expect(initialRoute.continue).toHaveBeenCalledOnce();
    expect(initialRoute.abort).not.toHaveBeenCalled();

    const redirectRoute = fakeRoute();
    await handler(redirectRoute, navigationRequest("http://169.254.169.254/internal"));

    expect(redirectRoute.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(redirectRoute.continue).not.toHaveBeenCalled();
  });
});
