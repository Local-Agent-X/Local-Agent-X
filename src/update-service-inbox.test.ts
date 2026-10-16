// An available update reaches the user's inbox once per version, however
// often the check runs, and the notice is resolved once the install is current.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = { remoteCommit: "def5678", version: "9.9.9", behind: "3", failFetch: false };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: (cmd: string) => {
      if (/rev-parse --short HEAD/.test(cmd)) return "abc1234\n";
      if (/fetch origin main/.test(cmd)) { if (git.failFetch) throw new Error("fatal: unable to access"); return ""; }
      if (/rev-parse --short origin\/main/.test(cmd)) return `${git.remoteCommit}\n`;
      if (/show origin\/main:package\.json/.test(cmd)) return JSON.stringify({ version: git.version });
      if (/log -1/.test(cmd)) return "subject line\n";
      if (/rev-list --count/.test(cmd)) return `${git.behind}\n`;
      return "";
    },
  };
});
vi.mock("./local-only-policy.js", () => ({ isLocalOnlyMode: () => false, LOCAL_ONLY_BLOCK_MESSAGE: "blocked" }));

const { checkForUpdate, bustUpdateCache } = await import("./update-service.js");
const { inboxStore } = await import("./inbox/index.js");

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-update-inbox-"));
  process.env.LAX_DATA_DIR = dir;
  Object.assign(git, { remoteCommit: "def5678", version: "9.9.9", behind: "3", failFetch: false });
  bustUpdateCache();
});
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

const updates = () => inboxStore().list().filter((i) => i.kind === "update");

describe("update availability in the inbox", () => {
  it("one item per version: repeated checks of the same version do not duplicate", async () => {
    await checkForUpdate(true);
    await checkForUpdate(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ title: "Update available: 9.9.9", needsYou: false });
    expect(updates()[0].body).toContain("def5678");

    git.version = "10.0.0";
    git.remoteCommit = "fff0000";
    await checkForUpdate(true);
    expect(updates().map((i) => i.title).sort()).toEqual(["Update available: 10.0.0", "Update available: 9.9.9"]);
  });

  it("a failed check posts and resolves nothing; a current install resolves the open notice", async () => {
    await checkForUpdate(true);
    git.failFetch = true;
    await checkForUpdate(true);
    expect(updates()[0].resolvedAt).toBeUndefined();

    git.failFetch = false;
    git.behind = "0";
    await checkForUpdate(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].resolvedAt).toBeDefined();
  });
});
