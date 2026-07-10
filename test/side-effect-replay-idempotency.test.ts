/**
 * Crash re-drive replay guard for send-class tools.
 *
 * The hole this locks down: canonical-loop recovery re-drives an
 * uncommitted turn from the model call (src/canonical-loop/recovery.ts).
 * If the process crashed AFTER `transport.sendMail` resolved but BEFORE
 * commitTurn persisted the turn, the re-driven turn re-executes the tool.
 * With the idempotency store held only in a process-local Map, the fresh
 * process misses `recentlyDone` and the transport FIRES TWICE — a real
 * recipient gets the same email twice.
 *
 * The store now persists to disk (src/tools/idempotency.ts), so this suite
 * proves the end-to-end property: execute email_send with a stubbed
 * transport, simulate the crash+restart (fresh module state, same data
 * dir), re-execute with identical args — the transport fires exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sendMail = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "stub-message-1" })),
);

vi.mock("nodemailer", () => ({
  createTransport: () => ({ sendMail }),
}));

import { emailSend } from "../src/tools/email-send-tool.js";
import {
  _clearIdempotencyStoreForTests,
  _resetIdempotencyForTests,
} from "../src/tools/idempotency.js";

const SMTP_ENV: Record<string, string> = {
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "sender@example.test",
  SMTP_PASS: "not-a-real-secret",
  SMTP_FROM: "sender@example.test",
};

const ARGS = {
  to: "alice@example.test",
  subject: "Replay guard",
  body: "This must be delivered exactly once.",
};

describe("send idempotency survives crash re-drive", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const [k, v] of Object.entries(SMTP_ENV)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }
    savedEnv.set("LAX_DATA_DIR", process.env.LAX_DATA_DIR);
    process.env.LAX_DATA_DIR = mkdtempSync(join(tmpdir(), "lax-replay-"));
    _resetIdempotencyForTests();
    sendMail.mockClear();
  });

  afterEach(() => {
    _clearIdempotencyStoreForTests();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetIdempotencyForTests();
  });

  it("re-executing an identical send after a simulated restart fires the transport exactly once", async () => {
    const first = await emailSend.execute(ARGS);
    expect(first.isError).toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(1);

    // Crash after sendMail resolved but before commitTurn persisted the
    // turn: the process restarts (fresh module Map, same data dir) and
    // recovery re-drives the turn with identical args.
    _resetIdempotencyForTests();

    const replay = await emailSend.execute(ARGS);
    expect(sendMail).toHaveBeenCalledTimes(1); // still exactly one real send
    expect(replay.isError).toBeUndefined();
    expect(String(replay.content)).toContain("already sent");
    expect(replay.metadata?.skipped).toBe("duplicate");
  });

  it("a different payload after the restart still sends", async () => {
    await emailSend.execute(ARGS);
    _resetIdempotencyForTests();

    const second = await emailSend.execute({ ...ARGS, subject: "Replay guard v2" });
    expect(second.isError).toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
