import { afterEach, describe, expect, it } from "vitest";
import {
  connectElectronCdp,
  getPageForView,
  closeElectronCdp,
  _setConnectorForTest,
} from "./electron-cdp.js";

// Fakes standing in for Playwright's Browser/Context/Page — no real socket. Each
// page's evaluate() resolves its stubbed window.name regardless of the script.
function fakePage(windowName: string) {
  return { evaluate: async (_script: unknown) => windowName };
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

afterEach(async () => {
  await closeElectronCdp();
  _setConnectorForTest(null);
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
