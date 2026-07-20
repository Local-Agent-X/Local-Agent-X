import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixture = resolve("test/fixtures/durable-jsonl-lock-worker.ts");
let root: string;
let gate: string;
let path: string;

beforeEach(() => {
  root = join(tmpdir(), `jsonl-race-${process.pid}-${Date.now()}`);
  gate = join(root, "gate");
  path = join(root, "events.jsonl");
  mkdirSync(gate, { recursive: true });
  const lock = `${path}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, "dead-token"), JSON.stringify({ pid: 99_999_999 }));
  const stale = new Date(Date.now() - 10_000);
  utimesSync(lock, stale, stale);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function start(id: string): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, ["--import=tsx", fixture, path, id, gate], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  });
  const done = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  return { child, done };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

describe("durable JSONL lock reclamation", () => {
  it("two reclaimers never delete the replacement owner's live token", async () => {
    const a = start("a");
    const b = start("b");
    await waitFor(() => existsSync(join(gate, "ready-a")) && existsSync(join(gate, "ready-b")), "ready");
    writeFileSync(join(gate, "go"), "go");
    await waitFor(() => existsSync(join(gate, "acquired-a")) || existsSync(join(gate, "acquired-b")), "acquired");
    const winner = existsSync(join(gate, "acquired-a")) ? a : b;
    const loser = winner === a ? b : a;
    expect(await loser.done).not.toBe(0);
    const lock = `${path}.lock`;
    expect(readdirSync(lock)).toHaveLength(1);
    writeFileSync(join(gate, "release"), "release");
    expect(await winner.done).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf-8")).id).toMatch(/a|b/);
  }, 20_000);
});
