/**
 * A git op that outlives its timeout must be killed as a whole TREE and
 * reported as a timeout.
 *
 * Regression (AB-5): gitRun used to spawn through cmd.exe on Windows, and its
 * timeout killed only that wrapper; the real git kept running holding
 * .git/index.lock, and the immediate build_plan_resume then failed every git
 * op until the orphan exited. gitRun now runs git through runCaged, whose
 * timeout kills the process tree (pinned in src/tools/caged-spawn.test.ts);
 * this file pins that gitRun hands it the deadline and reports its timeout.
 */

import { describe, it, expect, vi } from "vitest";

const runCagedMock = vi.fn();
vi.mock("../src/tools/caged-spawn.js", () => ({
  runCaged: (...args: unknown[]) => runCagedMock(...args),
}));
vi.mock("../src/sandbox/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sandbox/index.js")>()),
  awaitSandboxProof: async () => {},
  getSandboxMode: () => "host",
}));

import { getHeadSha } from "../src/auto-build/git-helpers.js";

describe("gitRun timeout", () => {
  it("runs git under the caged run's deadline and reports its timeout as one", async () => {
    runCagedMock.mockResolvedValue({ kind: "timeout", stdout: "", stderr: "warning: CRLF spam\n".repeat(100), durationMs: 30_000 });

    await expect(getHeadSha("/some/project")).rejects.toThrow(/^git rev-parse HEAD timed out after 30s/);
    expect(runCagedMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(["rev-parse", "HEAD"]) }),
      { cwd: "/some/project", timeoutMs: 30_000 },
    );
  });
});
