import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectElectronCdp,
  getPageForView,
  closeElectronCdp,
  _setConnectorForTest,
  _setTargetResolverForTest,
} from "./electron-cdp.js";

// Fakes standing in for Playwright's Browser/Context/Page — no real socket. Each
// page's evaluate() resolves its stubbed window.name regardless of the script,
// and its throwaway CDP session answers Target.getTargetInfo with its target id.
function fakePage(windowName: string, targetId = `target-of-${windowName}`) {
  return {
    evaluate: async (_script: unknown) => windowName,
    context: () => ({
      newCDPSession: async () => ({
        send: async (_method: string) => ({ targetInfo: { targetId } }),
        detach: async () => {},
      }),
    }),
  };
}

function fakeContext(pages: ReturnType<typeof fakePage>[]) {
  return { pages: () => pages };
}

function fakeBrowser(contexts: ReturnType<typeof fakeContext>[]) {
  return {
    isConnected: () => true,
    on: () => {},
    contexts: () => contexts,
    close: async () => {},
  };
}

// The desktop cannot name a target in these tests unless a test says so: the
// window.name fallback is what the connection tests exercise.
beforeEach(() => { _setTargetResolverForTest(async () => null); });

afterEach(async () => {
  await closeElectronCdp();
  _setConnectorForTest(null);
  _setTargetResolverForTest(null);
  delete process.env.LAX_ELECTRON_CDP_PORT;
});

describe("connectElectronCdp", () => {
  it("returns null when LAX_ELECTRON_CDP_PORT is unset", async () => {
    delete process.env.LAX_ELECTRON_CDP_PORT;
    let called = false;
    _setConnectorForTest(async () => {
      called = true;
      return fakeBrowser([]) as never;
    });
    expect(await connectElectronCdp()).toBeNull();
    expect(called).toBe(false); // must not attempt a socket when env is absent
  });

  it("connects via the injected connector when the port is set", async () => {
    process.env.LAX_ELECTRON_CDP_PORT = "51234";
    const browser = fakeBrowser([]);
    let seenUrl = "";
    _setConnectorForTest(async (url) => {
      seenUrl = url;
      return browser as never;
    });
    const b = await connectElectronCdp();
    expect(b).toBe(browser);
    expect(seenUrl).toBe("http://127.0.0.1:51234"); // first-party loopback only
  });

  it("returns null (never throws) when the connect fails", async () => {
    process.env.LAX_ELECTRON_CDP_PORT = "51234";
    _setConnectorForTest(async () => {
      throw new Error("boom");
    });
    expect(await connectElectronCdp()).toBeNull();
  });
});

describe("getPageForView", () => {
  it("returns the page whose window.name === viewId", async () => {
    process.env.LAX_ELECTRON_CDP_PORT = "51234";
    const target = fakePage("view-b");
    const browser = fakeBrowser([
      fakeContext([fakePage("view-a")]),
      fakeContext([target, fakePage("view-c")]),
    ]);
    _setConnectorForTest(async () => browser as never);

    const page = await getPageForView("view-b");
    expect(page).toBe(target);
  });

  it("returns null when no page matches the viewId", async () => {
    process.env.LAX_ELECTRON_CDP_PORT = "51234";
    const browser = fakeBrowser([fakeContext([fakePage("view-a"), fakePage("view-c")])]);
    _setConnectorForTest(async () => browser as never);

    expect(await getPageForView("view-b")).toBeNull();
  });

  it("returns null when there is no connection (env unset)", async () => {
    delete process.env.LAX_ELECTRON_CDP_PORT;
    _setConnectorForTest(async () => fakeBrowser([fakeContext([fakePage("view-b")])]) as never);
    expect(await getPageForView("view-b")).toBeNull();
  });

  it("skips pages whose evaluate throws and still finds a later match", async () => {
    process.env.LAX_ELECTRON_CDP_PORT = "51234";
    const flaky = { evaluate: async () => { throw new Error("navigated"); } };
    const target = fakePage("view-b");
    const browser = fakeBrowser([fakeContext([flaky as never, target])]);
    _setConnectorForTest(async () => browser as never);

    expect(await getPageForView("view-b")).toBe(target);
  });
});

describe("getPageForView — the desktop's target id, not the page's own word", () => {
  beforeEach(() => { process.env.LAX_ELECTRON_CDP_PORT = "51234"; });

  it("matches by the CDP target id the desktop names, ignoring a page that claims the viewId in window.name", async () => {
    // A hostile page can set window.name to another view's id; it cannot
    // change which CDP target it is.
    const spoofer = fakePage("view-b", "target-spoofer");
    const real = fakePage("", "target-real");
    _setConnectorForTest(async () => fakeBrowser([fakeContext([spoofer, real])]) as never);
    _setTargetResolverForTest(async (viewId) => (viewId === "view-b" ? "target-real" : null));

    expect(await getPageForView("view-b")).toBe(real);
  });

  it("returns null, never a window.name match, when no page is the named target", async () => {
    const spoofer = fakePage("view-b", "target-spoofer");
    _setConnectorForTest(async () => fakeBrowser([fakeContext([spoofer])]) as never);
    _setTargetResolverForTest(async () => "target-gone");

    expect(await getPageForView("view-b")).toBeNull();
  });

  it("skips a page whose session cannot be opened and still finds the target", async () => {
    const torn = { ...fakePage("", "x"), context: () => ({ newCDPSession: async () => { throw new Error("closed"); } }) };
    const real = fakePage("", "target-real");
    _setConnectorForTest(async () => fakeBrowser([fakeContext([torn as never, real])]) as never);
    _setTargetResolverForTest(async () => "target-real");

    expect(await getPageForView("view-b")).toBe(real);
  });

  it("falls back to window.name only when the desktop cannot name the target", async () => {
    const byName = fakePage("view-b", "target-by-name");
    _setConnectorForTest(async () => fakeBrowser([fakeContext([fakePage("view-a"), byName])]) as never);
    _setTargetResolverForTest(async () => null);

    expect(await getPageForView("view-b")).toBe(byName);
  });
});
