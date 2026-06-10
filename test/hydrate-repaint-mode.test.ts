// Regression: intermittent whole-window freeze (~30s). Periodic hydrates
// (reconcileSessionSnapshot, selectChat) called renderMessages() after EVERY
// hydrate — even when the server snapshot was identical to the local copy —
// and the full wipe-and-rebuild re-parses markdown + re-highlights code for
// every row, blocking the renderer main thread for tens of seconds on long
// threads. _hydrateRepaintMode now picks the cheapest correct repaint: the
// old behavior is the 'full' branch, reserved for snapshots the DOM can't
// be trusted to already show.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Msg = { role: string; content: string; _tools?: unknown[] };
type Mode = "skip" | "append" | "full";
let repaintMode: (keptLocal: boolean, local: Msg[], server: Msg[], streaming: boolean) => Mode;

beforeAll(() => {
  // app-sync.js is a classic script of top-level function declarations with
  // no boot-time side effects; execute the source and pull the pure decision
  // function out of the function scope.
  const src = readFileSync(join(here, "../public/js/app-sync.js"), "utf8");
  // eslint-disable-next-line no-new-func
  repaintMode = new Function(`${src}; return _hydrateRepaintMode;`)();
});

const row = (role: string, content: string, tools?: unknown[]): Msg =>
  tools ? { role, content, _tools: tools } : { role, content };

const thread: Msg[] = [
  row("user", "hey"),
  row("assistant", "hi Peter", [{ name: "web_search" }]),
  row("user", "do the thing"),
  row("assistant", "done"),
];

describe("_hydrateRepaintMode", () => {
  it("skips repaint when local messages were kept (snapshot discarded)", () => {
    expect(repaintMode(true, thread, [], false)).toBe("skip");
  });

  it("skips repaint when the server snapshot is identical — the recurring idle hydrate", () => {
    const server = thread.map((m) => ({ ...m, timestamp: 123 }));
    expect(repaintMode(false, thread, server, false)).toBe("skip");
  });

  it("appends when the server snapshot only extends the local thread", () => {
    const server = [...thread, row("assistant", "worker finished: report ready")];
    expect(repaintMode(false, thread, server, false)).toBe("append");
  });

  it("falls back to full render when prefix content diverges", () => {
    const server = thread.map((m, i) => (i === 1 ? row("assistant", "edited reply") : m));
    expect(repaintMode(false, thread, server, false)).toBe("full");
  });

  it("falls back to full render when server rows gained tool metadata", () => {
    const server = thread.map((m, i) => (i === 3 ? row("assistant", "done", [{ name: "bash" }]) : m));
    expect(repaintMode(false, thread, server, false)).toBe("full");
  });

  it("falls back to full render while the thread is streaming (live anchor row)", () => {
    const server = [...thread, row("assistant", "tail")];
    expect(repaintMode(false, thread, server, true)).toBe("full");
  });
});
