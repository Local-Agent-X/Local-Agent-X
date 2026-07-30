import { beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../event-bus.js";
import { getLaxDir } from "../lax-data-dir.js";
import { BrowserHistoryStore } from "./history-store.js";
import { _rewireHistoryRecorderForTest, recordAgentVisit } from "./history-recorder.js";

const mock = vi.hoisted(() => ({
  config: { enableUiEventBus: true } as { enableUiEventBus: boolean },
  warn: vi.fn(),
}));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getRuntimeConfig: () => mock.config };
});
vi.mock("../logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mock.warn, error: vi.fn(), debug: vi.fn() }),
}));

beforeEach(() => {
  mock.config = { enableUiEventBus: true };
  mock.warn.mockClear();
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  BrowserHistoryStore._resetForTest();
  _rewireHistoryRecorderForTest();
});

describe("history recorder", () => {
  it("records user and agent navigations into the shared history", async () => {
    await EventBus.emit("ui:browser", {
      surface: "browser",
      action: "navigate",
      target: "https://example.com/user",
    });
    recordAgentVisit("https://example.com/agent", "Agent");
    expect(BrowserHistoryStore.getInstance().query().map((e) => e.title)).toEqual(["Agent", ""]);
  });

  it("honors the live UI-event toggle", async () => {
    mock.config.enableUiEventBus = false;
    await EventBus.emit("ui:browser", {
      surface: "browser",
      action: "navigate",
      target: "https://example.com/off",
    });
    expect(BrowserHistoryStore.getInstance().query()).toHaveLength(0);
  });

  it("warns once instead of throwing on write failure", () => {
    const spy = vi.spyOn(BrowserHistoryStore.prototype, "recordVisit")
      .mockImplementation(() => { throw new Error("disk full"); });
    expect(() => recordAgentVisit("https://example.com/a")).not.toThrow();
    expect(() => recordAgentVisit("https://example.com/b")).not.toThrow();
    expect(mock.warn).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
