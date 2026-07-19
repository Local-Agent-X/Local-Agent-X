/**
 * SV-7 regression: config/policy JSON writers must be ATOMIC (tmp + rename).
 *
 * The finding: db-migrations and two settings routes rewrote config.json /
 * tool-policy.json / migration-version.json with a plain writeFileSync (no
 * tmp+rename). A concurrent reader (the config hot-reload watcher, a request
 * handler, or loadToolPolicy) could observe a half-written file → JSON.parse
 * throws → fallback-to-defaults → clobber. For tool-policy.json the fallback
 * is fail-OPEN (bash/http/browser default-allow), a security downgrade.
 *
 * The fix routes every one of these writes through atomicWriteFileSync
 * (src/server-utils.ts), which writes a private same-directory temp then renameSync()s it into
 * place — on POSIX an atomic swap, so a reader always sees either the whole
 * old file or the whole new one, never a truncated one.
 *
 * This suite asserts the INVARIANT, not an implementation detail we control:
 * for each target file T, the final path T is NEVER handed to writeFileSync
 * directly, and the bytes arrive via renameSync(privateTemp, T). On the pre-fix
 * code (plain writeFileSync(T, ...) with no rename) both assertions fail.
 *
 * We intercept node:fs by wrapping writeFileSync/renameSync as pass-throughs
 * that record their target paths — the real writes still happen, so behaviour
 * is unchanged; we only observe HOW the bytes land.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Recorders live in a hoisted scope so the vi.mock factory (hoisted above all
// imports) and the test body share the same arrays.
const rec = vi.hoisted(() => ({
  writes: [] as string[],
  renames: [] as Array<{ src: string; dest: string }>,
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: ((path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
      rec.writes.push(String(path));
      // @ts-expect-error — forward the exact args to the real impl.
      return actual.writeFileSync(path, ...rest);
    }) as typeof actual.writeFileSync,
    renameSync: ((src: Parameters<typeof actual.renameSync>[0], dest: Parameters<typeof actual.renameSync>[1]) => {
      rec.renames.push({ src: String(src), dest: String(dest) });
      return actual.renameSync(src, dest);
    }) as typeof actual.renameSync,
  };
});

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

const tmpDirs: string[] = [];
let dataDir: string;
let savedLaxDir: string | undefined;

beforeEach(() => {
  rec.writes.length = 0;
  rec.renames.length = 0;
  dataDir = mkdtempSync(join(tmpdir(), "sv7-atomic-"));
  tmpDirs.push(dataDir);
  savedLaxDir = process.env.LAX_DATA_DIR;
  // db-migrations built-ins resolve config.json / migration-version.json via
  // getLaxDir(), which honors LAX_DATA_DIR.
  process.env.LAX_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Assert file `target` was written atomically (tmp+rename), never in place. */
function expectAtomic(target: string): void {
  // The final path must never be handed to writeFileSync directly…
  expect(rec.writes).not.toContain(target);
  const landings = rec.renames.filter(({ dest }) => dest === target);
  expect(landings.length).toBeGreaterThan(0);
  expect(new Set(landings.map(({ src }) => src)).size).toBe(landings.length);
  for (const { src } of landings) {
    expect(dirname(src)).toBe(dirname(target));
    expect(src).not.toBe(target);
    expect(rec.writes).toContain(src);
    expect(existsSync(src)).toBe(false);
  }
}

describe("db-migrations writes migration-version.json atomically", () => {
  it("saveVersion() goes through tmp+rename", async () => {
    const { registerMigration, runMigrations } = await import("../src/db-migrations.js");
    registerMigration({ version: 90001, name: "sv7-probe", up: () => {} });
    const res = await runMigrations(dataDir);
    expect(res.error).toBeUndefined();
    expectAtomic(join(dataDir, "migration-version.json"));
  });
});

describe("db-migrations config-defaults migration writes config.json atomically", () => {
  it("v1 rewrite of config.json goes through tmp+rename", async () => {
    // Missing every default field → the config-defaults migration mutates and
    // rewrites config.json.
    writeFileSync(join(dataDir, "config.json"), "{}", "utf-8");
    rec.writes.length = 0; // ignore the fixture write above
    rec.renames.length = 0;
    const { runMigrations } = await import("../src/db-migrations.js");
    const res = await runMigrations(dataDir);
    expect(res.error).toBeUndefined();
    expectAtomic(join(dataDir, "config.json"));
  });
});

describe("POST /api/tool-policy/toggle writes tool-policy.json atomically", () => {
  it("read-modify-write of the policy file goes through tmp+rename", async () => {
    const { handleSecurityRoutes } = await import("../src/routes/security.js");
    const ctx = { dataDir } as unknown as ServerContext;
    const url = new URL("http://test/api/tool-policy/toggle");
    const req = mockJsonRequest({ tool: "bash", enabled: false });
    const cap = mockResponse();

    const handled = await handleSecurityRoutes("POST", url, req, cap.res, ctx, "operator");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expectAtomic(join(dataDir, "tool-policy.json"));
    // Sanity: the write actually persisted the toggle.
    const policy = JSON.parse(readFileSync(join(dataDir, "tool-policy.json"), "utf-8"));
    const bash = policy.rules.find((r: { id: string }) => r.id === "allow-bash-limited");
    expect(bash.decision).toBe("deny");
  });
});

describe("POST /api/auth/rotate writes config.json atomically", () => {
  it("token rotation persists config.json via tmp+rename", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ authToken: "old", port: 12345 }), "utf-8");
    rec.writes.length = 0;
    rec.renames.length = 0;
    const { handleSecurityRoutes } = await import("../src/routes/settings/security.js");
    const rotated: string[] = [];
    const ctx = {
      dataDir,
      config: { authToken: "old", port: 12345 },
      rbac: { rotateOperatorToken: (t: string) => { rotated.push(t); } },
    } as unknown as ServerContext;
    const url = new URL("http://test/api/auth/rotate");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleSecurityRoutes("POST", url, req, cap.res, ctx, "operator");

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expectAtomic(join(dataDir, "config.json"));
    // The rotated token was persisted, not just held in memory.
    const persisted = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8"));
    expect(persisted.authToken).toBe(rotated[0]);
    expect(persisted.authToken).not.toBe("old");
  });
});
