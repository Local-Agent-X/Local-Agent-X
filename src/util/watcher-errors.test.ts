/**
 * Regression: an fs.watch caller that only wrapped watch() in try/catch.
 *
 * That covers the synchronous creation throw and nothing else. A watcher
 * reports every later failure — the watched directory deleted or made
 * unreadable, EPERM on Windows — as an 'error' EVENT, and an EventEmitter
 * emitting 'error' with no listener rethrows it as an uncaught exception.
 * CI saw nine of those take the test process down.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import type { FSWatcher } from "node:fs";
import { handleWatcherErrors } from "./watcher-errors.js";

function fakeWatcher(): FSWatcher & { closed: number } {
  const emitter = new EventEmitter() as EventEmitter & { close(): void; closed: number };
  emitter.closed = 0;
  emitter.close = () => { emitter.closed += 1; };
  return emitter as unknown as FSWatcher & { closed: number };
}

describe("handleWatcherErrors", () => {
  it("swallows an async watcher error instead of letting it go uncaught", () => {
    const watcher = fakeWatcher();
    handleWatcherErrors(watcher, "probe");
    // Without a listener this throws: EventEmitter rethrows an unhandled 'error'.
    expect(() => watcher.emit("error", Object.assign(new Error("watch"), { code: "EPERM" })))
      .not.toThrow();
  });

  it("closes the watcher, since one that has errored is dead", () => {
    const watcher = fakeWatcher();
    handleWatcherErrors(watcher, "probe");
    watcher.emit("error", new Error("gone"));
    expect(watcher.closed).toBe(1);
  });

  it("does not mask a close() that itself fails during teardown", () => {
    const watcher = fakeWatcher();
    watcher.close = () => { throw new Error("already torn down"); };
    handleWatcherErrors(watcher, "probe");
    expect(() => watcher.emit("error", new Error("gone"))).not.toThrow();
  });

  it("returns the same watcher so call sites can wrap in place", () => {
    const watcher = fakeWatcher();
    expect(handleWatcherErrors(watcher, "probe")).toBe(watcher);
  });
});
