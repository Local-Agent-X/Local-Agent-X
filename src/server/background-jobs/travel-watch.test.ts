// "Your flight's delayed", unprompted: flights found on the calendar, looked
// up near departure with only the web tools, and a change rings the phone
// through quiet hours.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { AgentTurn, LAXConfig } from "../../types.js";
import { EventBus } from "../../event-bus.js";
import { listInbox } from "../../inbox/index.js";
import type { ReviewForkRequest } from "./review-fork.js";
import { registerTravelWatchRunner, runTravelWatchPass, lookupGapMs, type TravelWatchDeps } from "./travel-watch.js";
import { changeOf, flightNumberOf, parseFlightStatus } from "./travel-watch-prompt.js";

const ORIGINAL = getRuntimeConfig();
const prevDir = process.env.LAX_DATA_DIR;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-travel-"));
  process.env.LAX_DATA_DIR = dir;
  setRuntimeConfig({ ...ORIGINAL, travelWatchEnabled: true, localOnlyMode: false } as LAXConfig);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => {
  setRuntimeConfig(ORIGINAL);
  if (prevDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDir;
});

const reply = (o: unknown): AgentTurn => ({ messages: [{ role: "assistant", content: JSON.stringify(o) }], stopReason: "end_turn" } as unknown as AgentTurn);
const DEPART = "2026-11-15T14:00:00.000Z";

function setup(answers: unknown[], at: string) {
  let now = new Date(at);
  const forks: ReviewForkRequest[] = [];
  const runFork = vi.fn(async (req: ReviewForkRequest) => { forks.push(req); return reply(answers.shift() ?? { found: false }); });
  const webTool = { name: "web_search" } as never;
  const d: TravelWatchDeps = {
    config: getRuntimeConfig(), dataDir: dir, secretsStore: {} as never, security: {} as never, toolPolicy: {} as never,
    webTools: () => [webTool],
    now: () => now,
    window: async () => ({ events: [
      { id: "f", title: "Flight AA12 DFW→LAX", start: DEPART, end: "2026-11-15T17:00:00.000Z", location: "DFW", sourceId: "lax" },
      { id: "m", title: "Dentist", start: "2026-11-15T16:00:00.000Z", end: "2026-11-15T17:00:00.000Z", sourceId: "lax" },
    ], unreadable: [] }),
    runFork: runFork as unknown as TravelWatchDeps["runFork"],
  };
  registerTravelWatchRunner(d);
  return { forks, runFork, setNow: (s: string) => { now = new Date(s); } };
}

describe("travel watch", () => {
  it("looks up only flights, with only the web tools, and says nothing while it is on time", async () => {
    const { forks } = setup([{ found: true, status: "on-time", departure: DEPART, gate: null }], "2026-11-14T15:00:00.000Z");
    expect(await runTravelWatchPass()).toMatchObject({ looked: 1, alerts: 0 });
    expect(forks).toHaveLength(1);
    expect(forks[0]!.tools.map((t) => t.name)).toEqual(["web_search"]);
    expect(forks[0]!.message).toContain("Flight AA12");
    expect(listInbox().items).toEqual([]);
  });

  it("a delay rings through quiet hours; the same status again says nothing; the next lookup waits its turn", async () => {
    const rings: boolean[] = [];
    const listen = ({ ringThroughQuietHours }: { ringThroughQuietHours?: boolean }) => { rings.push(ringThroughQuietHours === true); };
    EventBus.on("inbox:posted", listen);
    const late = { found: true, status: "delayed", departure: "2026-11-15T15:10:00.000Z", gate: "C12" };
    const { runFork, setNow } = setup([late, late], "2026-11-15T09:00:00.000Z");
    await runTravelWatchPass();
    EventBus.off("inbox:posted", listen);
    expect(listInbox().items[0]?.title).toMatch(/^Flight AA12 is delayed: now departing/);
    expect(rings).toEqual([true]);
    await runTravelWatchPass();
    expect(runFork).toHaveBeenCalledTimes(1); // 5 h out: next lookup an hour later
    setNow("2026-11-15T10:01:00.000Z");
    await runTravelWatchPass();
    expect(runFork).toHaveBeenCalledTimes(2);
    expect(listInbox().items).toHaveLength(1);
  });

  it("is off when the user switched it off, and in strict local-only mode", async () => {
    const { runFork } = setup([], "2026-11-15T09:00:00.000Z");
    setRuntimeConfig({ ...getRuntimeConfig(), travelWatchEnabled: false } as LAXConfig);
    expect((await runTravelWatchPass()).skipped).toBe("disabled");
    setRuntimeConfig({ ...getRuntimeConfig(), travelWatchEnabled: true, localOnlyMode: true } as LAXConfig);
    expect((await runTravelWatchPass()).skipped).toBe("local-only");
    expect(runFork).not.toHaveBeenCalled();
  });
});

describe("reading flights", () => {
  it("finds flight numbers only in flight events", () => {
    expect(flightNumberOf("Flight AA12 DFW→LAX")).toBe("AA12");
    expect(flightNumberOf("✈ ua 2145 to Denver")).toBe("UA2145");
    expect(flightNumberOf("Flight B6 515")).toBe("B6515");
    expect(flightNumberOf("Room A1 2 meeting")).toBeNull();
    expect(flightNumberOf("Flight to Denver")).toBeNull();
  });

  it("reads the lookup's answer strictly and never invents one", () => {
    expect(parseFlightStatus('{"found":true,"status":"delayed","departure":"2026-11-15T15:10:00Z","gate":"null"}')).toEqual({ status: "delayed", departure: "2026-11-15T15:10:00Z" });
    expect(parseFlightStatus('{"found":false,"status":"unknown"}')).toBeNull();
    expect(parseFlightStatus("sorry, could not find it")).toBeNull();
  });

  it("tells what changed: cancellations, new times (15 min or more), gate changes", () => {
    const s = DEPART;
    expect(changeOf(undefined, { status: "cancelled" }, s)).toBe("is cancelled");
    expect(changeOf(undefined, { status: "on-time", departure: s }, s)).toBeNull();
    expect(changeOf({ status: "delayed", departure: "2026-11-15T15:00:00Z" }, { status: "delayed", departure: "2026-11-15T15:05:00Z" }, s)).toBeNull();
    expect(changeOf({ status: "delayed", departure: "2026-11-15T15:00:00Z" }, { status: "delayed", departure: "2026-11-15T15:45:00Z" }, s)).toMatch(/^is delayed further/);
    expect(changeOf({ status: "on-time", gate: "C12" }, { status: "on-time", gate: "D4" }, s)).toBe("changed gate: C12 → D4");
  });

  it("looks more often as departure nears", () => {
    expect(lookupGapMs(20 * 3600_000)).toBe(18 * 3600_000);
    expect(lookupGapMs(5 * 3600_000)).toBe(3600_000);
    expect(lookupGapMs(2 * 3600_000)).toBe(20 * 60_000);
  });
});
