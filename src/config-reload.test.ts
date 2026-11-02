// The config watcher's hot reload (server/lifecycle.ts startConfigWatcher)
// goes through reloadRuntimeConfig. Boot hands the live config object to the
// server context (ctx.config), the request handler and closures set up once;
// a reload that swapped in a NEW object left every one of them on the
// boot-time values while only getRuntimeConfig() callers saw the change.
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeConfig, reloadRuntimeConfig, setRuntimeConfig } from "./config.js";
import type { LAXConfig } from "./types.js";

const before = getRuntimeConfig();
afterEach(() => setRuntimeConfig(before));

describe("reloadRuntimeConfig", () => {
  it("updates the live object in place, so a holder of the boot object sees the reload", () => {
    const boot = { port: 7007, toolApproval: "auto", enableShell: true, staleKey: 1 } as unknown as LAXConfig;
    setRuntimeConfig(boot);
    const heldByCtx = getRuntimeConfig();

    reloadRuntimeConfig({ port: 7007, toolApproval: "confirm-risky", enableShell: false } as unknown as LAXConfig);

    expect(getRuntimeConfig()).toBe(heldByCtx);
    expect(heldByCtx.toolApproval).toBe("confirm-risky");
    expect(heldByCtx.enableShell).toBe(false);
    // A key the reloaded file no longer has is gone, not left behind.
    expect("staleKey" in heldByCtx).toBe(false);
  });
});
