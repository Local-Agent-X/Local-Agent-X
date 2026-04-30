import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import { sendIpc, receiveIpc } from "../src/workers/ipc.js";
import { ipcEnvelope, type IpcMessage, IPC_PROTOCOL_VERSION } from "../src/workers/types.js";

function captureSink(): { stream: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf-8"));
      cb();
    },
  });
  return { stream, chunks };
}

function sourceStream(): Readable {
  return new Readable({ read() {} });
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe("sendIpc", () => {
  it("writes a single JSON line terminated by \\n", () => {
    const { stream, chunks } = captureSink();
    const msg = ipcEnvelope("ping", { fromTs: "2026-04-30T00:00:00Z" }) as IpcMessage;
    sendIpc(stream, msg);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].endsWith("\n")).toBe(true);
    const parsed = JSON.parse(chunks[0].trimEnd());
    expect(parsed.type).toBe("ping");
    expect(parsed.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
  });

  it("writes valid JSON for envelopes with non-trivial payloads", () => {
    const { stream, chunks } = captureSink();
    const msg = ipcEnvelope("redirect", { opId: "op-x", instruction: "stop\nand do this" }) as IpcMessage;
    sendIpc(stream, msg);
    const parsed = JSON.parse(chunks[0].trimEnd());
    expect(parsed.payload.opId).toBe("op-x");
    expect(parsed.payload.instruction).toContain("\n");
  });

  it("does not pretty-print (single line per message)", () => {
    const { stream, chunks } = captureSink();
    sendIpc(stream, ipcEnvelope("ping", { fromTs: "x" }) as IpcMessage);
    const newlines = (chunks[0].match(/\n/g) || []).length;
    expect(newlines).toBe(1);
  });
});

describe("receiveIpc", () => {
  it("emits onMessage for a complete JSON line", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    receiveIpc(stream, { onMessage });
    const msg = ipcEnvelope("ping", { fromTs: "x" });
    stream.push(JSON.stringify(msg) + "\n");
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].type).toBe("ping");
  });

  it("buffers across chunk boundaries", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    receiveIpc(stream, { onMessage });
    const msg = ipcEnvelope("ping", { fromTs: "x" });
    const line = JSON.stringify(msg) + "\n";
    stream.push(line.slice(0, 10));
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
    stream.push(line.slice(10));
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("handles multiple complete messages in a single chunk", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    receiveIpc(stream, { onMessage });
    const a = JSON.stringify(ipcEnvelope("ping", { fromTs: "a" })) + "\n";
    const b = JSON.stringify(ipcEnvelope("ping", { fromTs: "b" })) + "\n";
    stream.push(a + b);
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("strips trailing \\r so CRLF lines parse on Windows", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    receiveIpc(stream, { onMessage });
    stream.push(JSON.stringify(ipcEnvelope("ping", { fromTs: "x" })) + "\r\n");
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("skips blank lines silently", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const onNonIpcLine = vi.fn();
    receiveIpc(stream, { onMessage, onNonIpcLine });
    stream.push("\n\n\n");
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onNonIpcLine).not.toHaveBeenCalled();
  });

  it("calls onNonIpcLine for invalid JSON", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const onNonIpcLine = vi.fn();
    receiveIpc(stream, { onMessage, onNonIpcLine });
    stream.push("worker said hi\n");
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onNonIpcLine).toHaveBeenCalledWith("worker said hi");
  });

  it("calls onNonIpcLine for valid JSON that isn't an IPC envelope", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const onNonIpcLine = vi.fn();
    receiveIpc(stream, { onMessage, onNonIpcLine });
    stream.push(JSON.stringify({ random: "object" }) + "\n");
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onNonIpcLine).toHaveBeenCalled();
  });

  it("calls onError for protocol version mismatch", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const onError = vi.fn();
    receiveIpc(stream, { onMessage, onError });
    const bad = {
      protocolVersion: 999,
      messageId: "m-x",
      type: "ping",
      ts: "2026-04-30T00:00:00Z",
      payload: { fromTs: "x" },
    };
    stream.push(JSON.stringify(bad) + "\n");
    await tick();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toContain("protocol version");
  });

  it("calls onError when buffered line exceeds maxLineBytes", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const onError = vi.fn();
    receiveIpc(stream, { onMessage, onError, maxLineBytes: 50 });
    stream.push("x".repeat(100));
    await tick();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toContain("line too long");
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("recovers after an oversized line by accepting subsequent valid messages", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const okLine = JSON.stringify(ipcEnvelope("ping", { fromTs: "ok" })) + "\n";
    receiveIpc(stream, { onMessage, onError, maxLineBytes: okLine.length + 50 });
    stream.push("x".repeat(okLine.length + 100));
    await tick();
    expect(onError).toHaveBeenCalled();
    stream.push(okLine);
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("detach function stops emitting onMessage for further data", async () => {
    const stream = sourceStream();
    const onMessage = vi.fn();
    const detach = receiveIpc(stream, { onMessage });
    stream.push(JSON.stringify(ipcEnvelope("ping", { fromTs: "1" })) + "\n");
    await tick();
    detach();
    stream.push(JSON.stringify(ipcEnvelope("ping", { fromTs: "2" })) + "\n");
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("survives a round-trip via sendIpc -> receiveIpc", async () => {
    const captured: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { captured.push(Buffer.from(chunk)); cb(); },
    });
    sendIpc(sink, ipcEnvelope("redirect", { opId: "op-1", instruction: "go" }) as IpcMessage);
    const upstream = sourceStream();
    const onMessage = vi.fn();
    receiveIpc(upstream, { onMessage });
    upstream.push(Buffer.concat(captured));
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].type).toBe("redirect");
  });
});

describe("ipcEnvelope", () => {
  it("stamps the current protocol version", () => {
    const env = ipcEnvelope("ping", { fromTs: "x" });
    expect(env.protocolVersion).toBe(IPC_PROTOCOL_VERSION);
  });

  it("generates unique messageIds across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) ids.add(ipcEnvelope("ping", { fromTs: "x" }).messageId);
    expect(ids.size).toBe(30);
  });

  it("messageIds embed the message type", () => {
    const env = ipcEnvelope("redirect", { opId: "op-x", instruction: "go" });
    expect(env.messageId.startsWith("redirect-")).toBe(true);
  });

  it("ts is an ISO date", () => {
    const env = ipcEnvelope("ping", { fromTs: "x" });
    expect(() => new Date(env.ts).toISOString()).not.toThrow();
  });
});
