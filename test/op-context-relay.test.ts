/**
 * Regression: a delegated op must be seeded with the originating session's
 * recent turns, so a terse task is read against the actual conversation.
 *
 * The bug this guards: buildOpFromArgs never passed parentSessionMessages, so
 * every worker started with recentTurns=[]. A four-word task ("set up an
 * agent") reached the worker with zero context; it had to guess or bail with a
 * clarifying question that went nowhere. Repro: op_freeform_fb70f4adc7544035.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildOpFromArgs } from "../src/ops/tools/shared.js";
import { setSessionMessageReader } from "../src/ops/session-bridge.js";

describe("op context relay", () => {
  afterEach(() => setSessionMessageReader(() => []));

  it("seeds recentTurns from the originating session", async () => {
    setSessionMessageReader((sid) =>
      sid === "chat-relay-test"
        ? [
            { role: "user", content: "let's set up a background research agent" },
            { role: "assistant", content: "Sure — what should it research?" },
            { role: "user", content: "set up an agent" },
          ]
        : [],
    );

    const op = await buildOpFromArgs({ task: "set up an agent", lane: "interactive", _sessionId: "chat-relay-test" });
    const turns = op.contextPack.context.recentTurns;
    expect(turns.length).toBeGreaterThan(0);
    expect(JSON.stringify(turns)).toContain("background research agent");
  });

  it("returns empty recentTurns when there is no session id (never throws)", async () => {
    const op = await buildOpFromArgs({ task: "do a thing", lane: "interactive" });
    expect(op.contextPack.context.recentTurns).toEqual([]);
  });

  it("returns empty recentTurns for an unknown session (reader yields nothing)", async () => {
    setSessionMessageReader(() => []);
    const op = await buildOpFromArgs({ task: "do a thing", lane: "interactive", _sessionId: "unknown" });
    expect(op.contextPack.context.recentTurns).toEqual([]);
  });
});
