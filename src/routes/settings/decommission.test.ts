import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  DECOMMISSION_CONFIRM_PHRASE,
  buildUninstallLaunch,
  handleDecommissionRoutes,
  resolveUninstallScript,
} from "./decommission.js";

describe("resolveUninstallScript", () => {
  it("prefers the staged copy in ~/.lax/uninstall over the checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "lax-decom-"));
    try {
      const name = process.platform === "win32" ? "lax-uninstall.ps1" : "lax-uninstall.sh";
      const laxDir = join(root, "lax");
      const repoRoot = join(root, "repo");
      mkdirSync(join(laxDir, "uninstall"), { recursive: true });
      mkdirSync(join(repoRoot, "scripts", "uninstall"), { recursive: true });
      writeFileSync(join(laxDir, "uninstall", name), "# staged");
      writeFileSync(join(repoRoot, "scripts", "uninstall", name), "# checkout");
      expect(resolveUninstallScript(process.platform, laxDir, repoRoot)).toBe(join(laxDir, "uninstall", name));
      // Staged copy gone (pre-fix install) — falls back to the checkout.
      rmSync(join(laxDir, "uninstall", name));
      expect(resolveUninstallScript(process.platform, laxDir, repoRoot)).toBe(join(repoRoot, "scripts", "uninstall", name));
      // Neither exists — null, never a guessed path.
      rmSync(join(repoRoot, "scripts", "uninstall", name));
      expect(resolveUninstallScript(process.platform, laxDir, repoRoot)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildUninstallLaunch", () => {
  it("maps options to the Windows script flags", () => {
    expect(buildUninstallLaunch("win32", "C:\\s.ps1", {})).toEqual({
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\s.ps1", "-Yes"],
    });
    expect(buildUninstallLaunch("win32", "C:\\s.ps1", { deleteData: true }).args).toContain("-DeleteData");
    const dry = buildUninstallLaunch("win32", "C:\\s.ps1", { dryRun: true }).args;
    expect(dry).toContain("-DryRun");
    expect(dry).not.toContain("-Yes");
  });

  it("maps options to the POSIX script flags", () => {
    expect(buildUninstallLaunch("darwin", "/s.sh", {})).toEqual({ command: "bash", args: ["/s.sh", "--yes"] });
    expect(buildUninstallLaunch("linux", "/s.sh", { deleteData: true }).args).toEqual(["/s.sh", "--yes", "--delete-data"]);
    expect(buildUninstallLaunch("darwin", "/s.sh", { dryRun: true }).args).toEqual(["/s.sh", "--dry-run"]);
  });
});

describe("decommission routes", () => {
  function makeReq(body?: unknown): Readable & { headers: Record<string, string> } {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Readable.from(chunks) as Readable & { headers: Record<string, string> };
    req.headers = {};
    return req;
  }

  function makeRes() {
    const res = {
      statusCode: 0,
      body: "",
      writeHead(status: number) { res.statusCode = status; return res; },
      end(chunk?: string) { if (chunk) res.body = chunk; return res; },
    };
    return res;
  }

  async function request(method: "GET" | "POST", path: string, role: string, body?: unknown) {
    const req = makeReq(body);
    const res = makeRes();
    const handled = await handleDecommissionRoutes(
      method,
      new URL(`http://127.0.0.1${path}`),
      req as unknown as Parameters<typeof handleDecommissionRoutes>[2],
      res as unknown as Parameters<typeof handleDecommissionRoutes>[3],
      {} as Parameters<typeof handleDecommissionRoutes>[4],
      role as Parameters<typeof handleDecommissionRoutes>[5],
    );
    return { handled, status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
  }

  it("rejects non-operator roles on both endpoints", async () => {
    const plan = await request("GET", "/api/decommission/plan", "user");
    expect(plan.handled).toBe(true);
    expect(plan.status).toBe(403);
    const run = await request("POST", "/api/decommission/run", "user", { confirm: DECOMMISSION_CONFIRM_PHRASE });
    expect(run.handled).toBe(true);
    expect(run.status).toBe(403);
  });

  it("refuses to run without the exact confirmation phrase", async () => {
    for (const confirm of [undefined, "", "decommission", "yes"]) {
      const r = await request("POST", "/api/decommission/run", "operator", { deleteData: true, confirm });
      expect(r.status).toBe(400);
    }
  });

  it("leaves unrelated paths unhandled", async () => {
    const r = await request("GET", "/api/decommission/other", "operator");
    expect(r.handled).toBe(false);
  });
});
