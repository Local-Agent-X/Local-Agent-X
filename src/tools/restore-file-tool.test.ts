/**
 * restore_file — the delete-protection loop closes.
 *
 * The round-trip runs through the REAL dispatch pipeline (executeToolCalls:
 * resolve → policy → approval → sandbox), so a registration omission fails
 * here as a live failure, not just in the contract suites: the trusted
 * _sessionId stamp (SESSION_SCOPED_TOOLS) is what locates the task-trash
 * scope, and the policy allow rule is what lets the call through at all.
 *
 * Also pinned: the REGISTRY-COHERENCE invariant. delete_file un-enrolls the
 * artifact when it moves it into the task trash (a USER file later created at
 * the same path must not inherit the artifact's shell rm-deny), and
 * restore_file re-enrolls the restored path (the protections return with the
 * bytes) — asserted against the real shell-path-guard both ways.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { executeToolCalls } from "../tool-execution/execute-tool.js";
import { dedupRecord, dedupLookup } from "../tool-execution/dedup-cache.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { SecurityLayer } from "../security/index.js";
import { stampedDefaultPolicy, ToolPolicy } from "../tool-policy/index.js";
import { evaluateShellCommandAndPaths } from "../security/layer/shell-path-guard.js";
import { setSessionProfile, clearSessionProfile } from "../autonomy/profile-store.js";
import { recordTaskArtifact, isTaskArtifact, clearTaskArtifacts } from "../data-lineage/task-artifacts.js";
import { deleteFileTool } from "./read-write-tools.js";
import { restoreFileTool } from "./restore-file-tool.js";
import type { ToolDefinition } from "../types.js";

let laxDir: string;
let workDir: string;
let seq = 0;
let sid: string;
const prevEnv = process.env.LAX_DATA_DIR;
const toolMap = new Map<string, ToolDefinition>([
  [deleteFileTool.name, deleteFileTool],
  [restoreFileTool.name, restoreFileTool],
]);

beforeAll(() => setAriRequired(false));
afterAll(() => {
  setAriRequired(true);
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
});

beforeEach(() => {
  laxDir = mkdtempSync(join(tmpdir(), "lax-restore-lax-"));
  workDir = mkdtempSync(join(tmpdir(), "lax-restore-work-"));
  process.env.LAX_DATA_DIR = laxDir;
  sid = `restore-tool-sess-${seq++}`;
  setSessionProfile(sid, "Power");
});

afterEach(() => {
  clearSessionProfile(sid);
  clearTaskArtifacts(sid);
  for (const d of [laxDir, workDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

async function dispatch(name: string, args: Record<string, unknown>, mode: "unrestricted" | "workspace" = "unrestricted"): Promise<string> {
  const security = new SecurityLayer(workDir, mode);
  const messages = await executeToolCalls(
    [{ id: `call-${seq++}`, name, arguments: JSON.stringify(args) }],
    toolMap,
    security,
    new ToolPolicy(stampedDefaultPolicy()),
    undefined, undefined, undefined,
    sid,
    undefined, undefined, undefined, undefined, undefined,
    "local",
  );
  expect(messages).toHaveLength(1);
  return String(messages[0].content ?? "");
}

/** The same ctx shape shell-path-guard.task-artifacts.test.ts drives the
 *  guard with — unrestricted mode, so ONLY the artifact rule can deny. */
function rmDecision(path: string): { allowed: boolean; reason?: string } {
  return evaluateShellCommandAndPaths(`rm ${path}`, {
    workspace: workDir,
    fileAccessMode: "unrestricted",
    inlineEvalPolicy: "allow",
    allowedPathCheck: () => true,
    sessionId: sid,
  });
}

describe("restore_file round-trip through the real dispatch pipeline", () => {
  it("delete_file → restore_file brings the artifact back byte-identical; the registry entry follows the file (shell-guard interaction)", async () => {
    const f = join(workDir, "deliverable.txt");
    writeFileSync(f, "agent-made bytes", "utf-8");
    recordTaskArtifact(sid, f);
    expect(rmDecision(f).allowed).toBe(false); // enrolled → shell hard-delete denied

    const delContent = await dispatch("delete_file", { path: f });
    expect(delContent).toContain(`restore_file({ path: "${f}" })`);
    expect(existsSync(f)).toBe(false);
    // UN-ENROLL pin: the artifact left the world — a user file recreated at
    // the same path must not inherit the rm-deny from a sticky entry.
    expect(isTaskArtifact(sid, f)).toBe(false);
    writeFileSync(f, "the user's own recreation", "utf-8");
    expect(rmDecision(f).allowed).toBe(true);
    rmSync(f); // clear the path — restore refuses to overwrite

    const restoreContent = await dispatch("restore_file", { path: f });
    expect(restoreContent).toContain(`Restored ${f}`);
    expect(readFileSync(f, "utf-8")).toBe("agent-made bytes");
    // RE-ENROLL pin: the bytes are back, so the protections come back too.
    expect(isTaskArtifact(sid, f)).toBe(true);
    expect(rmDecision(f).allowed).toBe(false);
  });

  it("surfaces safe-delete's clear error through the err envelope when nothing matches", async () => {
    const content = await dispatch("restore_file", { path: join(workDir, "never-trashed.txt") });
    expect(content).toContain("No task-trash entry matches");
    expect(content).toContain("Nothing was restored");
  });

  it("restore_file is DEDUP_SKIP-pinned: even a forced cache record is never served back", () => {
    // The skeptic's probe showed the dedup hazard LATENT today (the record
    // phase doesn't capture on this path), so the behavioral cycle below
    // can't discriminate membership — this unit pin does: seed the cache
    // directly; a skip-listed tool must never round-trip.
    const args = JSON.stringify({ path: join(workDir, "dedup-probe.txt") });
    dedupRecord(sid, "restore_file", args, { msgs: [], allowed: true, resultContent: "Restored (stale)" });
    expect(dedupLookup(sid, "restore_file", args)).toBeNull();
    // Control: a non-skipped name round-trips, proving the seed/lookup works.
    dedupRecord(sid, "not_a_skiplisted_tool", args, { msgs: [], allowed: true, resultContent: "cached" });
    expect(dedupLookup(sid, "not_a_skiplisted_tool", args)).not.toBeNull();
  });

  it("delete→restore→delete→restore with identical args re-executes every leg (end-to-end truthfulness; belt if dedup recording ever goes live here)", async () => {
    const f = join(workDir, "cycle.txt");
    writeFileSync(f, "v1", "utf-8");
    recordTaskArtifact(sid, f);

    await dispatch("delete_file", { path: f });
    const r1 = await dispatch("restore_file", { path: f });
    expect(r1).toContain(`Restored ${f}`);
    expect(readFileSync(f, "utf-8")).toBe("v1");

    // Cycle 2, byte-identical args, well inside the 60s dedup window. If
    // restore_file were dedup-cached, this would replay cycle 1's "Restored"
    // while the bytes sit in the trash — the same false-progress class
    // delete_file is already skipped for.
    await dispatch("delete_file", { path: f });
    expect(existsSync(f)).toBe(false);
    const r2 = await dispatch("restore_file", { path: f });
    expect(r2).toContain(`Restored ${f}`);
    expect(readFileSync(f, "utf-8")).toBe("v1");

    // A THIRD identical restore now truthfully reports the consumed entry —
    // a cached replay would have claimed success instead.
    const r3 = await dispatch("restore_file", { path: f });
    expect(r3).toContain("No task-trash entry matches");
  });
});

describe("restore_file taught flow in a CONFINED mode (workspace) — the absolute path IS the contract", () => {
  it("absolute original path + absolute inside destination work end-to-end under the write gate", async () => {
    const f = join(workDir, "report.md");
    writeFileSync(f, "# findings", "utf-8");
    recordTaskArtifact(sid, f);
    const delContent = await dispatch("delete_file", { path: f }, "workspace");
    expect(delContent).toContain(`restore_file({ path: "${f}" })`); // the taught spelling is absolute

    const restored = await dispatch("restore_file", { path: f }, "workspace");
    expect(restored).toContain(`Restored ${f}`);
    expect(readFileSync(f, "utf-8")).toBe("# findings");

    // Recovered entry (lost manifest) + absolute destination inside the
    // workspace, same basename — the taught recovery flow, gate-clean.
    await dispatch("delete_file", { path: f }, "workspace"); // restore re-enrolled it above
    writeFileSync(join(laxDir, "trash", "task", sid, ".manifest.json"), "{ not json", "utf-8");
    const dest = join(workDir, "recovered", "report.md");
    const viaDest = await dispatch("restore_file", { path: f, destination: dest }, "workspace");
    expect(viaDest).toContain(`Restored ${dest}`);
    expect(readFileSync(dest, "utf-8")).toBe("# findings");
  });

  it("a bare basename is gate-blocked in workspace mode BEFORE the restore runs — why the absolute path is taught", async () => {
    const f = join(workDir, "note.txt");
    writeFileSync(f, "n", "utf-8");
    recordTaskArtifact(sid, f);
    await dispatch("delete_file", { path: f }, "workspace");

    // A bare name resolves to the PROJECT ROOT (workspace parent) — outside
    // the workspace — so the write gate refuses it; the file is NOT lost.
    const bare = await dispatch("restore_file", { path: "note.txt" }, "workspace");
    expect(bare).toContain("Blocked");
    expect(existsSync(f)).toBe(false); // nothing restored, nothing clobbered

    const abs = await dispatch("restore_file", { path: f }, "workspace");
    expect(abs).toContain(`Restored ${f}`);
    expect(readFileSync(f, "utf-8")).toBe("n");
  });
});

describe("restore_file envelope edges (direct execute)", () => {
  it("refuses to overwrite a file that now exists at the original path", async () => {
    const f = join(workDir, "notes.txt");
    writeFileSync(f, "agent version", "utf-8");
    recordTaskArtifact(sid, f);
    await deleteFileTool.execute({ path: f, _sessionId: sid });
    writeFileSync(f, "user re-created this", "utf-8");
    const r = await restoreFileTool.execute({ path: f, _sessionId: sid });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("Refusing to overwrite");
    expect(readFileSync(f, "utf-8")).toBe("user re-created this");
  });

  it("without a session there is no scope — clear error, nothing restored", async () => {
    const r = await restoreFileTool.execute({ path: "whatever.txt" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("no session context");
  });

  it("recovered entry: the error teaches the destination contract, a matching-basename destination restores + re-enrolls, a renamed one matches nothing", async () => {
    const f = join(workDir, "figures.csv");
    writeFileSync(f, "col,val", "utf-8");
    recordTaskArtifact(sid, f);
    await deleteFileTool.execute({ path: f, _sessionId: sid });
    // Lose the manifest (the recovery path): original paths are gone.
    writeFileSync(join(laxDir, "trash", "task", sid, ".manifest.json"), "{ not json", "utf-8");

    const noDest = await restoreFileTool.execute({ path: "figures.csv", _sessionId: sid });
    expect(noDest.isError).toBe(true);
    expect(String(noDest.content)).toContain("full destination path");
    expect(String(noDest.content)).toContain('basename must be "figures.csv"');

    // A destination with a DIFFERENT basename can never match a recovered
    // entry — the constraint the description and the error both teach.
    const renamed = await restoreFileTool.execute(
      { path: "figures.csv", destination: join(workDir, "recovered", "renamed.csv"), _sessionId: sid },
    );
    expect(renamed.isError).toBe(true);
    expect(String(renamed.content)).toContain("No task-trash entry matches");

    const dest = join(workDir, "recovered", "figures.csv");
    const ok = await restoreFileTool.execute({ path: "figures.csv", destination: dest, _sessionId: sid });
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(dest, "utf-8")).toBe("col,val");
    expect(basename(dest)).toBe("figures.csv");
    expect(isTaskArtifact(sid, dest)).toBe(true); // re-enrolled at the recovered destination
  });
});
