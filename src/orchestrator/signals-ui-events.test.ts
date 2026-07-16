import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventBus } from "../event-bus.js";

// Same live-toggle mock as ui-event-store.test.ts — the flag must be
// swappable mid-test. Only getRuntimeConfig is overridden; everything else
// in config.js stays real for transitive importers.
const mock = vi.hoisted(() => ({ config: { enableUiEventBus: true } as { enableUiEventBus: boolean } }));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getRuntimeConfig: () => mock.config };
});

import { uiEventSignals, _rewireUiEventBusForTest } from "./signals-ui-events.js";
import { _resetUiEventStoreForTest, recordUiEvent } from "./ui-event-store.js";
import type { ModuleSignal, OrchestratorInput } from "./types.js";
import { buildParagraph } from "./signals.js";

const uiSignal = uiEventSignals[0];

function inputFor(sessionId: string): OrchestratorInput {
  return { message: "what am I looking at?", sessionId, sessionMessages: [], timeOfDay: 12, dayOfWeek: 3 };
}

beforeEach(() => {
  mock.config = { enableUiEventBus: true };
  _resetUiEventStoreForTest();
});

describe("registry entry shape", () => {
  it("declares the ui-events module with run/triage/health", () => {
    expect(uiSignal.id).toBe("ui-events");
    expect(uiSignal.scope).toBe("profile");
    expect(typeof uiSignal.triage).toBe("function");
    expect(typeof uiSignal.run).toBe("function");
    expect(uiSignal.health!()).toBeTruthy();
  });
});

describe("event-bus → store → signal (integration)", () => {
  it("ui:browser events emitted on the real bus surface as ONE digest ModuleSignal", async () => {
    _rewireUiEventBusForTest();
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "x.com", sessionId: "int-1", ts: 1 });
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "x.com/compose", sessionId: "int-1", ts: 2 });
    await EventBus.emit("ui:browser", { surface: "browser", action: "title", target: "Compose post", sessionId: "int-1", ts: 3 });

    expect(uiSignal.triage!({ input: inputFor("int-1"), msgCount: 1 })).toBe("conditional");

    const out: ModuleSignal[] = [];
    uiSignal.run!(inputFor("int-1"), out);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "ui-events", category: "recall" });
    expect(out[0].signal).toBe("Browser: user navigated x.com → x.com/compose; page title 'Compose post'");
    expect(out[0].priority).toBeGreaterThan(0);
    expect(out[0].priority).toBeLessThan(8); // never in the veto/critical band
  });

  it("the digest's category renders through buildParagraph's contextual bucket", () => {
    recordUiEvent({ surface: "browser", action: "navigate", target: "x.com", sessionId: "p-1", ts: 1 });
    const out: ModuleSignal[] = [];
    uiSignal.run!(inputFor("p-1"), out);
    expect(buildParagraph(out)).toContain("user navigated to x.com");
  });

  it("bus payloads that violate the schema are rejected by the store, not buffered", async () => {
    _rewireUiEventBusForTest();
    await EventBus.emit("ui:browser", "just a string");
    await EventBus.emit("ui:browser", { action: "navigate", ts: 1, sessionId: "int-2" }); // no surface
    expect(uiSignal.triage!({ input: inputFor("int-2"), msgCount: 1 })).toBeNull();
  });
});

describe("freshness — the same activity is injected once, not every turn", () => {
  it("run() advances the cursor: second run emits nothing until new events arrive", () => {
    recordUiEvent({ surface: "browser", action: "navigate", target: "x.com", sessionId: "f-1", ts: 10 });

    const first: ModuleSignal[] = [];
    uiSignal.run!(inputFor("f-1"), first);
    expect(first).toHaveLength(1);

    const second: ModuleSignal[] = [];
    uiSignal.run!(inputFor("f-1"), second);
    expect(second).toHaveLength(0);
    expect(uiSignal.triage!({ input: inputFor("f-1"), msgCount: 2 })).toBeNull();

    recordUiEvent({ surface: "browser", action: "navigate", target: "x.com/next", sessionId: "f-1", ts: 11 });
    const third: ModuleSignal[] = [];
    uiSignal.run!(inputFor("f-1"), third);
    expect(third).toHaveLength(1);
    expect(third[0].signal).toContain("x.com/next");
  });
});

describe("enableUiEventBus toggle — off means no signal anywhere in the path", () => {
  it("triage skips and run emits nothing while disabled", () => {
    recordUiEvent({ surface: "browser", action: "navigate", target: "x.com", sessionId: "t-1", ts: 1 });
    mock.config = { enableUiEventBus: false };
    expect(uiSignal.triage!({ input: inputFor("t-1"), msgCount: 1 })).toBeNull();
    const out: ModuleSignal[] = [];
    uiSignal.run!(inputFor("t-1"), out);
    expect(out).toHaveLength(0);
  });
});
