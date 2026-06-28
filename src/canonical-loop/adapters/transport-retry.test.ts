import { describe, it, expect } from "vitest";
import { withTransportRetry } from "./transport-retry.js";

// A minimal TransportEvent-shaped union for the test.
type Ev =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done" }
  | { type: "error"; code: string; message: string; retryable?: boolean };

/**
 * Build a stream factory that returns the i-th scripted episode on the i-th
 * call. Each episode is the full list of events for one attempt. Tracks how
 * many times the factory (i.e. a fresh provider request) was invoked.
 */
function scripted(episodes: Ev[][]) {
  let calls = 0;
  const factory = () => {
    const idx = Math.min(calls, episodes.length - 1);
    calls++;
    return (async function* () {
      for (const ev of episodes[idx]) yield ev;
    })();
  };
  return { factory, calls: () => calls };
}

async function collect(stream: AsyncIterable<Ev>): Promise<Ev[]> {
  const out: Ev[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const noDelay = () => Promise.resolve();

describe("withTransportRetry", () => {
  it("retries a transient (overload) error then yields the successful stream", async () => {
    const { factory, calls } = scripted([
      [{ type: "error", code: "transport_error", message: "Overloaded (529)", retryable: false }],
      [{ type: "text", delta: "hello" }, { type: "done" }],
    ]);

    const out = await collect(withTransportRetry(factory, { label: "t", delay: noDelay }));

    expect(calls()).toBe(2); // re-issued once
    expect(out).toEqual([{ type: "text", delta: "hello" }, { type: "done" }]);
    // The first attempt's error event is swallowed — never forwarded.
    expect(out.some(e => e.type === "error")).toBe(false);
  });

  it("retries a 429 rate-limit error", async () => {
    const { factory, calls } = scripted([
      [{ type: "error", code: "transport_error", message: "rate_limit_error: 429 too many requests" }],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const out = await collect(withTransportRetry(factory, { label: "t", delay: noDelay }));
    expect(calls()).toBe(2);
    expect(out).toEqual([{ type: "text", delta: "ok" }, { type: "done" }]);
  });

  it("does NOT retry once content has been emitted — surfaces the error instead", async () => {
    const { factory, calls } = scripted([
      [
        { type: "text", delta: "partial" },
        { type: "error", code: "transport_error", message: "Overloaded (529)" },
        { type: "done" },
      ],
    ]);

    const out = await collect(withTransportRetry(factory, { label: "t", delay: noDelay }));

    expect(calls()).toBe(1); // no re-issue after partial text — would double-emit
    expect(out).toEqual([
      { type: "text", delta: "partial" },
      { type: "error", code: "transport_error", message: "Overloaded (529)" },
      { type: "done" },
    ]);
  });

  it("does NOT retry a non-transient (auth) error — forwards it immediately", async () => {
    const { factory, calls } = scripted([
      [{ type: "error", code: "auth", message: "invalid_api_key (401)" }, { type: "done" }],
    ]);

    const out = await collect(withTransportRetry(factory, { label: "t", delay: noDelay }));

    expect(calls()).toBe(1);
    expect(out).toEqual([
      { type: "error", code: "auth", message: "invalid_api_key (401)" },
      { type: "done" },
    ]);
  });

  it("is bounded by maxAttempts then forwards the last error", async () => {
    const err: Ev = { type: "error", code: "transport_error", message: "network fetch failed" };
    const { factory, calls } = scripted([[err], [err], [err], [err]]);

    const out = await collect(
      withTransportRetry(factory, { label: "t", maxAttempts: 3, delay: noDelay }),
    );

    expect(calls()).toBe(3); // initial + 2 retries, no more
    expect(out).toEqual([err]); // final attempt's error is surfaced
  });

  it("does not retry when the turn is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { factory, calls } = scripted([
      [{ type: "error", code: "transport_error", message: "Overloaded (529)" }],
      [{ type: "text", delta: "should-not-reach" }, { type: "done" }],
    ]);

    const out = await collect(
      withTransportRetry(factory, { label: "t", signal: ac.signal, delay: noDelay }),
    );

    expect(calls()).toBe(1);
    expect(out).toEqual([{ type: "error", code: "transport_error", message: "Overloaded (529)" }]);
  });

  it("re-throws a non-transient thrown exception without retrying", async () => {
    let calls = 0;
    const factory = () => {
      calls++;
      return (async function* (): AsyncGenerator<Ev> {
        throw new Error("invalid schema for tool argument");
      })();
    };
    await expect(collect(withTransportRetry(factory, { label: "t", delay: noDelay }))).rejects.toThrow(
      /invalid schema/,
    );
    expect(calls).toBe(1);
  });

  it("retries a transient thrown exception (econnreset) then succeeds", async () => {
    let calls = 0;
    const factory = () => {
      const n = calls++;
      return (async function* (): AsyncGenerator<Ev> {
        if (n === 0) throw new Error("read ECONNRESET");
        yield { type: "text", delta: "recovered" };
        yield { type: "done" };
      })();
    };
    const out = await collect(withTransportRetry(factory, { label: "t", delay: noDelay }));
    expect(calls).toBe(2);
    expect(out).toEqual([{ type: "text", delta: "recovered" }, { type: "done" }]);
  });
});
