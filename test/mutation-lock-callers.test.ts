import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf-8");

describe("shared mutation-lock async caller contract", () => {
  it("awaits ownership and release in every mutating entry point", () => {
    const sandbox = source("src/self-edit/sandbox.ts");
    const cancellation = source("src/self-edit/sandbox-cancellation.ts");
    const tool = source("src/self-edit/tool.ts");
    const update = source("src/update-pipeline.ts");
    const installer = source("scripts/installer/orchestrator.mjs");
    expect(sandbox).toMatch(/await acquireSandboxLease/);
    expect(cancellation).toMatch(/await acquireGlobalSelfEditLock/);
    expect(sandbox).toMatch(/await releaseGlobalSelfEditLock/);
    expect(tool).toMatch(/await acquireGlobalSelfEditLock/);
    expect(tool).toMatch(/await releaseGlobalSelfEditLock/);
    expect(update.match(/await acquireGlobalSelfEditLock/g)).toHaveLength(2);
    expect(update.match(/await releaseGlobalSelfEditLock/g)).toHaveLength(2);
    expect(installer).toMatch(/await acquireMutationLock/);
    expect(installer).toMatch(/await releaseMutationLock/);
  });

  it("awaits the kernel-backed boot-sweep observation", () => {
    expect(source("src/agency/worktree-junctions.ts")).toMatch(/await isSelfEditLockHeldByLiveProcess/);
  });

  it("routes installer state mutations through the identity-bound data root", () => {
    expect(source("scripts/installer/orchestrator.mjs")).toMatch(/bindInstallerDataRoot\(context\)/);
    for (const path of ["scripts/installer/core-steps.mjs", "scripts/installer/checkpoint.mjs", "scripts/installer/persistence.mjs"]) {
      expect(source(path)).toMatch(/mutateInstallerDataRoot\(context/);
    }
  });
});
