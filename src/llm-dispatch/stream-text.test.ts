// A side call reads its reply off a stream. A reply that did not finish is no
// reply: both readers throw, so the caller falls back as for any failed call.
import { describe, expect, it } from "vitest";
import { anthropicStreamText, codexStreamText } from "./stream-text.js";

async function* events<T>(...list: T[]): AsyncGenerator<T> {
  for (const e of list) yield e;
}

describe("anthropicStreamText", () => {
  it("joins the text of a finished reply", async () => {
    expect(await anthropicStreamText(events(
      { type: "text", delta: "YES" }, { type: "text", delta: ", because" }, { type: "done" },
    ))).toBe("YES, because");
  });

  it("throws on a transport error, whatever text came before it", async () => {
    await expect(anthropicStreamText(events(
      { type: "text", delta: "Here is the sum" }, { type: "error", error: "Please run /login" },
    ))).rejects.toThrow("Please run /login");
  });

  it("stops at the caller's cut and returns the text so far", async () => {
    let read = 0;
    const stream = (async function* () {
      for (const delta of ["aaaa", "bbbb", "cccc"]) { read++; yield { type: "text", delta }; }
    })();
    expect(await anthropicStreamText(stream, { maxChars: 6 })).toBe("aaaabbbb");
    expect(read).toBe(2);
  });
});

describe("codexStreamText", () => {
  it("joins the text of a reply the API ended", async () => {
    expect(await codexStreamText(events(
      { type: "text", delta: "NO" }, { type: "done", stopReason: "completed" },
    ))).toBe("NO");
  });

  it("keeps a reply the API cut at its output limit: it ended, with a reason", async () => {
    expect(await codexStreamText(events(
      { type: "text", delta: "a long summary" }, { type: "done", stopReason: "max_output_tokens" },
    ))).toBe("a long summary");
  });

  it("throws when the stream closed before the API ended the reply", async () => {
    // What the client yields after a dropped connection or its silence timer:
    // the text that had arrived, then a `done` with no stop reason.
    await expect(codexStreamText(events(
      { type: "text", delta: "The conversation so far cov" }, { type: "done" },
    ))).rejects.toThrow("closed before the reply finished");
    await expect(codexStreamText(events({ type: "text", delta: "partial" }))).rejects.toThrow("closed before");
  });

  it("names the caller's own abort as the reason when that is what closed it", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(codexStreamText(events({ type: "text", delta: "par" }, { type: "done" }), { signal: ac.signal }))
      .rejects.toThrow("aborted");
  });

  it("stops at the caller's cut without waiting for the ending", async () => {
    expect(await codexStreamText(events(
      { type: "text", delta: "aaaa" }, { type: "text", delta: "bbbb" }, { type: "text", delta: "cccc" },
    ), { maxChars: 6 })).toBe("aaaabbbb");
  });
});
