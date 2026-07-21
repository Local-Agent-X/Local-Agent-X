import { createConnection, createServer } from "node:net";
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CAN_CREATE_FILE_SYMLINK } from "../src/symlink-capabilities.test-helper.js";

const DATA_DIR = mkdtempSync(join(tmpdir(), "lax-lock-test-"));
process.env.LAX_DATA_DIR = DATA_DIR;
const LOCK = join(DATA_DIR, "self-edit-sandbox.lock");
const {
  acquireGlobalSelfEditLock, releaseGlobalSelfEditLock, isSelfEditLockHeldByLiveProcess,
} = await import("../src/self-edit/global-lock.js");
const { mutationLockEndpoint, resolveWindowsProcessIncarnation } = await import("../scripts/installer/transaction-lock.mjs");

beforeEach(() => { rmSync(LOCK, { recursive: true, force: true }); });

describe("global installation mutation lock", () => {
  it("falls back to Get-Process when CIM process metadata is inaccessible", () => {
    const commands: string[] = [];
    const runner = (_file: unknown, args: unknown[]) => {
      const command = String(args.at(-1));
      commands.push(command);
      return command.includes("Get-CimInstance") ? { status: 1, stdout: "" } : { status: 0, stdout: "638887680000000000\n" };
    };
    expect(resolveWindowsProcessIncarnation(42, runner, "C:\\Windows")).toBe("win:638887680000000000");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("Get-Process");
  });

  it("acquires, blocks overlap, releases, and reacquires", async () => {
    const first = await acquireGlobalSelfEditLock({ task: "first" });
    expect(first.acquired).toBe(true);
    const blocked = await acquireGlobalSelfEditLock({ task: "second" });
    expect(blocked.acquired).toBe(false);
    expect(blocked.holder?.incarnation).toMatch(/^(linux|win|posix):/);
    await releaseGlobalSelfEditLock(first.nonce);
    const second = await acquireGlobalSelfEditLock({ task: "second" });
    expect(second.acquired).toBe(true);
    await releaseGlobalSelfEditLock(second.nonce);
  });

  it("does not let an unsafe rescue force-steal the live kernel claim", async () => {
    const first = await acquireGlobalSelfEditLock({ task: "normal" });
    expect(first.acquired).toBe(true);
    expect((await acquireGlobalSelfEditLock({ force: true, task: "rescue" })).acquired).toBe(false);
    await releaseGlobalSelfEditLock(first.nonce);
  });

  it("reclaims valid evidence from a dead process after taking the kernel claim", async () => {
    writeFileSync(LOCK, JSON.stringify({
      version: 2, pid: 2_147_483_646, ticket: "dead", incarnation: "dead:1", startedAt: "2020-01-01T00:00:00.000Z",
    }));
    const lock = await acquireGlobalSelfEditLock();
    expect(lock.acquired).toBe(true);
    await releaseGlobalSelfEditLock(lock.nonce);
  });

  it("reclaims evidence when a live PID has a different process incarnation", async () => {
    writeFileSync(LOCK, JSON.stringify({
      version: 2, pid: process.ppid, ticket: "reused", incarnation: "not-the-current-process", startedAt: "2020-01-01T00:00:00.000Z",
    }));
    const lock = await acquireGlobalSelfEditLock();
    expect(lock.acquired).toBe(true);
    await releaseGlobalSelfEditLock(lock.nonce);
  });

  it("does not treat current v2 metadata as ownership without the kernel claim", async () => {
    writeFileSync(LOCK, JSON.stringify({
      version: 2, pid: process.pid, ticket: "abandoned", incarnation: "stale", startedAt: new Date().toISOString(),
    }));
    const replacement = await acquireGlobalSelfEditLock();
    expect(replacement.acquired).toBe(true);
    await releaseGlobalSelfEditLock(replacement.nonce);
  });

  it("preserves cross-version exclusion for a live legacy owner", async () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, nonce: "legacy", startedAt: new Date().toISOString() }));
    expect((await acquireGlobalSelfEditLock()).acquired).toBe(false);
  });

  it("reclaims a legacy record whose PID was reused by a newer process", async () => {
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, nonce: "reused", startedAt: "2020-01-01T00:00:00.000Z" }));
    const replacement = await acquireGlobalSelfEditLock();
    expect(replacement.acquired).toBe(true);
    await releaseGlobalSelfEditLock(replacement.nonce);
  });

  it("fails closed without replacing corrupt evidence", async () => {
    writeFileSync(LOCK, "{not json");
    expect((await acquireGlobalSelfEditLock()).acquired).toBe(false);
    expect(readFileSync(LOCK, "utf-8")).toBe("{not json");
  });

  it("fails closed without removing non-regular evidence", async () => {
    mkdirSync(LOCK);
    expect((await acquireGlobalSelfEditLock()).acquired).toBe(false);
    expect(lstatSync(LOCK).isDirectory()).toBe(true);
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("fails closed without following or removing linked evidence", async () => {
    const outside = join(DATA_DIR, "outside-lock");
    writeFileSync(outside, "outside");
    symlinkSync(outside, LOCK, "file");
    expect((await acquireGlobalSelfEditLock()).acquired).toBe(false);
    expect(readFileSync(outside, "utf-8")).toBe("outside");
  });

  it("fails closed when an unrelated process already owns the kernel endpoint", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(mutationLockEndpoint(DATA_DIR).listen, resolve);
    });
    try { expect((await acquireGlobalSelfEditLock()).acquired).toBe(false); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("reports the live kernel owner to the boot sweep", async () => {
    expect(await isSelfEditLockHeldByLiveProcess()).toBe(false);
    const lock = await acquireGlobalSelfEditLock();
    expect(lock.acquired).toBe(true);
    expect(await isSelfEditLockHeldByLiveProcess()).toBe(true);
    await releaseGlobalSelfEditLock(lock.nonce);
    expect(await isSelfEditLockHeldByLiveProcess()).toBe(false);
    expect(existsSync(LOCK)).toBe(false);
  });

  it("survives a client that disconnects during the kernel reply", async () => {
    const lock = await acquireGlobalSelfEditLock({ task: "disconnect owner" });
    expect(lock.acquired).toBe(true);
    const socket = createConnection(mutationLockEndpoint(DATA_DIR).listen);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ action: "observe", rootHash: "wrong" })}\n`);
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await acquireGlobalSelfEditLock({ task: "still blocked" })).acquired).toBe(false);
    await releaseGlobalSelfEditLock(lock.nonce);
  });

  it("does not let an unauthenticated kernel client revoke a live owner", async () => {
    let revoked = 0;
    const lock = await acquireGlobalSelfEditLock({ task: "protected", onRevoke: () => { revoked += 1; } });
    expect(lock.acquired).toBe(true);
    const endpoint = mutationLockEndpoint(DATA_DIR);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(endpoint.listen);
      let response = "";
      socket.setEncoding("utf-8");
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${JSON.stringify({ action: "revoke", rootHash: endpoint.rootHash })}\n`));
      socket.on("data", (chunk) => {
        response += chunk;
        if (response.includes("\n")) resolve(JSON.parse(response.split(/\r?\n/, 1)[0]));
      });
    });
    expect(reply.revokeAccepted).toBe(false);
    expect(revoked).toBe(0);
    expect((await acquireGlobalSelfEditLock({ task: "still blocked" })).acquired).toBe(false);
    await releaseGlobalSelfEditLock(lock.nonce);
  });
});
