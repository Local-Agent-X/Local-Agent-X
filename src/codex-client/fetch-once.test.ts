import { afterEach, describe, expect, it, vi } from "vitest";
import { withTransportRetry } from "../canonical-loop/public/build-adapters.js";
import { fetchCodexOnce } from "./fetch-once.js";

type Event =
  | { type: "done" }
  | { type: "error"; code: string; message: string };

async function collect(stream: AsyncIterable<Event>): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe("single provider retry owner", () => {
  it("caps a persistent 503 at three underlying dispatches", async () => {
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const makeStream = () => (async function* (): AsyncGenerator<Event> {
      try {
        await fetchCodexOnce({ url: "https://example.test", headers: {}, body: {} });
        yield { type: "done" };
      } catch (error) {
        yield { type: "error", code: "transport_error", message: (error as Error).message };
      }
    })();

    const events = await collect(withTransportRetry(makeStream, {
      label: "provider",
      maxAttempts: 3,
      delay: async () => {},
    }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("503") });
  });
});
