// A key file the agent's own command made is not the user's secret: naming it
// does not withhold a command's output. TB2 openssl-selfsigned-cert
// (2026-10-24, 2026-10-29): `openssl genpkey -out /app/ssl/server.key && …
// && ls -la /app/ssl/` came back withheld, and so did every later check of
// the files the agent had just made. A key that existed before, or one copied
// from it, is withheld as before.
//
// Drives the real execute phase. bash is a stand-in whose execute does what
// the command would to the disk and returns what it would print, since the
// seam keys on the tool name and the command text.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxedPhase } from "./run-sandboxed.js";
import { clearSessionTaint, getTaintSummary } from "../data-lineage/index.js";
import { clearMintedKeys } from "../data-lineage/minted-keys.js";
import { statusOf } from "../tools/result-helpers.js";
import type { ToolCallContext } from "./context.js";
import type { ToolDefinition, ToolResult } from "../types.js";

const PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----";

let dir: string;
const sessions: string[] = [];

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "minted-keys-")).replace(/\\/g, "/"); });
afterAll(() => {
  for (const s of sessions) { clearSessionTaint(s); clearMintedKeys(s); }
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function session(): string {
  const s = `minted-${seq++}`;
  sessions.push(s);
  return s;
}

/** Run `command` through the execute phase as `bash`; `effect` is what it does to the disk. */
async function run(sessionId: string, command: string, stdout: string, effect: () => void = () => {}): Promise<ToolResult> {
  const tool = {
    name: "bash",
    description: "stand-in",
    parameters: { type: "object", properties: {} },
    execute: async () => { effect(); return { content: stdout }; },
  } as ToolDefinition;
  const args = { command };
  const ctx = {
    tc: { id: `tc${seq++}`, name: "bash", arguments: JSON.stringify(args) },
    toolMap: new Map([["bash", tool]]),
    tool, args, sessionId, callContext: "local", riskLevel: "low", approvalContext: "", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
  await runSandboxedPhase(ctx);
  return ctx.result!;
}

const withheld = (r: ToolResult) => statusOf(r) === "blocked" && /redacted by data-lineage gate/.test(r.content);

describe("a key file this session's own command made", () => {
  it("is not withheld by the command that makes it, nor by a later one; the session is not tainted", async () => {
    const sid = session();
    const key = `${dir}/a/server.key`, pem = `${dir}/a/server.pem`;
    const made = await run(sid,
      `mkdir -p ${dir}/a && openssl genpkey -algorithm RSA -out ${key} && cat ${key} ${dir}/a/server.crt > ${pem} && ls -la ${dir}/a/`,
      "server.crt\nserver.key\nserver.pem",
      () => { mkdirSync(`${dir}/a`, { recursive: true }); writeFileSync(key, PRIVATE_KEY); writeFileSync(pem, PRIVATE_KEY); });
    expect(withheld(made)).toBe(false);
    expect(made.content).toContain("server.pem");

    const later = await run(sid, `grep BEGIN ${pem} && openssl pkey -in ${key} -pubout`, "-----BEGIN PRIVATE KEY-----\n-----BEGIN PUBLIC KEY-----");
    expect(withheld(later)).toBe(false);
    expect(getTaintSummary(sid).count).toBe(0);
  });

  it("still has a private-key block masked when a command prints it", async () => {
    const sid = session();
    const key = `${dir}/b.key`;
    await run(sid, `openssl genpkey -algorithm RSA -out ${key} && ls ${key}`, key, () => writeFileSync(key, PRIVATE_KEY));
    const printed = await run(sid, `cat ${key}`, PRIVATE_KEY);
    expect(withheld(printed)).toBe(false);
    expect(printed.content).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
  });

  it("is not withheld when the command made it and removed it again", async () => {
    const sid = session();
    const key = `${dir}/d.key`, certPub = `${dir}/cert_pub.pem`, keyPub = `${dir}/key_pub.pem`;
    await run(sid, `openssl genpkey -algorithm RSA -out ${key} && ls ${key}`, key, () => writeFileSync(key, PRIVATE_KEY));
    const compared = await run(sid,
      `openssl x509 -in ${dir}/d.crt -noout -pubkey > ${certPub} && openssl pkey -in ${key} -pubout > ${keyPub} && diff -q ${certPub} ${keyPub} && echo "KEY MATCHES CERT" && rm ${certPub} ${keyPub}`,
      "KEY MATCHES CERT",
      () => { writeFileSync(certPub, "x"); writeFileSync(keyPub, "x"); rmSync(certPub); rmSync(keyPub); });
    expect(withheld(compared)).toBe(false);
    expect(compared.content).toContain("KEY MATCHES CERT");
  });

  it("is this session's alone: another session naming it is withheld", async () => {
    const key = `${dir}/c.key`;
    await run(session(), `openssl genpkey -algorithm RSA -out ${key} && ls ${key}`, key, () => writeFileSync(key, PRIVATE_KEY));
    expect(withheld(await run(session(), `openssl pkey -in ${key} -noout`, ""))).toBe(true);
  });
});

describe("a key file that is not this session's own", () => {
  it("is withheld when it existed before the command", async () => {
    const key = `${dir}/user.key`;
    writeFileSync(key, PRIVATE_KEY);
    expect(withheld(await run(session(), `openssl pkey -in ${key} -pubout`, "-----BEGIN PUBLIC KEY-----"))).toBe(true);
  });

  it("is withheld when the command that made it read a key that existed", async () => {
    const sid = session();
    const user = `${dir}/user2.key`, copy = `${dir}/copy.key`;
    writeFileSync(user, PRIVATE_KEY);
    expect(withheld(await run(sid, `cp ${user} ${copy} && cat ${copy}`, PRIVATE_KEY, () => writeFileSync(copy, PRIVATE_KEY)))).toBe(true);
    expect(withheld(await run(sid, `cat ${copy}`, PRIVATE_KEY))).toBe(true);

    const out = `${dir}/out.pem`;
    await run(sid, `cat ${user} > ${out}`, "", () => writeFileSync(out, PRIVATE_KEY));
    expect(withheld(await run(sid, `grep BEGIN ${out}`, "-----BEGIN PRIVATE KEY-----"))).toBe(true);
  });

  it("is withheld when the command left a link where no file was", async (ctx) => {
    const user = `${dir}/user3.key`, link = `${dir}/link.key`;
    writeFileSync(user, PRIVATE_KEY);
    const r = await run(session(), `python3 make_link.py && cat ${link}`, PRIVATE_KEY, () => {
      try { symlinkSync(user, link); } catch { ctx.skip(); } // Windows without the symlink privilege
    });
    expect(withheld(r)).toBe(true);
  });

  it("is withheld when named by a relative path, which is not followed to where the shell runs", async () => {
    const sid = session();
    expect(withheld(await run(sid, `openssl genpkey -out ssl/rel.key && cat ssl/rel.key`, PRIVATE_KEY))).toBe(true);
  });
});
