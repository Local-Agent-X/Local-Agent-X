import { describe, it, expect, beforeEach, vi } from "vitest";

// The gate anchors to the op's first user message; ops in this test have no
// on-disk message store, so pin the request text here.
vi.mock("../store.js", () => ({
  opRequestText: vi.fn(() => "Remove every tailnet reference from the app"),
  appliedRedirectTexts: vi.fn(() => []),
}));

import { opRequestText, appliedRedirectTexts } from "../store.js";
import { runSpecAuditGate, clearSpecAuditStateForOp, _resetSpecAuditState, namedPathEvidence, describeNamedPath } from "./spec-audit.js";
import type { Op } from "../../ops/types.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const op = (id: string) => ({ id } as Op);
const PATHS = ["/proj/app/errors.ts"];
const DIFF = "diff --git a/errors.ts b/errors.ts\n- tailnet\n+ desktop";

const evidenceOk = vi.fn(async () => DIFF);
const auditWith = (verdict: string[] | null) => vi.fn(async () => verdict);

beforeEach(() => {
  _resetSpecAuditState();
  vi.clearAllMocks();
  (opRequestText as ReturnType<typeof vi.fn>).mockReturnValue(
    "Remove every tailnet reference from the app",
  );
  (appliedRedirectTexts as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

// The auditor sees only the write/edit diff; a deliverable a shell command
// made was reported missing (TB2 openssl-selfsigned-cert, 2026-10-29). The
// paths the request names now go in front of the diff as they are on disk.
describe("namedPathEvidence", () => {
  it("lists each path the request names once, as the disk has it, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-audit-"));
    mkdirSync(join(root, "ssl"));
    writeFileSync(join(root, "ssl", "server.crt"), "-----BEGIN CERTIFICATE-----\nMIIB\n");
    const request = `Create /app/ssl/server.crt and /app/ssl/server.key, then write "check_cert.py" (see ./notes/plan.md, also /app/ssl/server.crt).`;
    const text = namedPathEvidence(request, (p) => join(root, p.replace(/^\/app\//, "").replace(/^\.\//, "")));
    expect(text).toContain("FILES THE REQUEST NAMES");
    expect(text).toContain("/app/ssl/server.crt: file, 33 bytes; begins: -----BEGIN CERTIFICATE----- ⏎ MIIB ⏎ ");
    expect(text).toContain("/app/ssl/server.key: does not exist");
    expect(text).toContain("./notes/plan.md: does not exist");
    expect(text.match(/server\.crt/g)).toHaveLength(1);
    expect(text).not.toContain("check_cert.py"); // a bare name is not a path
  });

  it("is empty when the request names no path, and skips a path the resolver refuses", () => {
    expect(namedPathEvidence("Remove every tailnet reference from the app", (p) => p)).toBe("");
    expect(namedPathEvidence("fix /etc/shadow", () => { throw new Error("outside"); })).toBe("");
    expect(describeNamedPath(join(tmpdir(), "no-such-file-" + Date.now()))).toBe("does not exist");
  });
});

describe("runSpecAuditGate", () => {
  it("puts the request's named paths, as they are on disk, ahead of the diff the auditor reads", async () => {
    (opRequestText as ReturnType<typeof vi.fn>).mockReturnValue("Write the plan to /app/out/plan.jsonl using the data in /app/data");
    const audit = auditWith([]);
    await runSpecAuditGate(op("named"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit, describeNamedPath: (abs) => `seen ${abs.replace(/\\/g, "/")}` });
    const { evidence } = (audit.mock.calls[0] as unknown as [{ evidence: string }])[0];
    expect(evidence.startsWith("FILES THE REQUEST NAMES")).toBe(true);
    expect(evidence).toMatch(/\/app\/out\/plan\.jsonl: seen .*plan\.jsonl/);
    expect(evidence).toMatch(/\/app\/data: seen .*data/);
    expect(evidence.endsWith(DIFF)).toBe(true);
  });

  it("unmet findings → one retry nudge naming the items", async () => {
    const audit = auditWith(['"remove every tailnet ref" — errors.ts still shows "Tailscale network"']);
    const r = await runSpecAuditGate(op("a"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(true);
    expect(r.nudge).toContain("Tailscale network");
    expect(r.nudge).toContain("fresh eyes");
    expect(audit).toHaveBeenCalledOnce();
  });

  it("fires at most once per op — the re-claimed done is not re-audited", async () => {
    const audit = auditWith(["item"]);
    await runSpecAuditGate(op("b"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    const second = await runSpecAuditGate(op("b"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(second.shouldRetry).toBe(false);
    expect(audit).toHaveBeenCalledOnce();
  });

  it("an all-met verdict is a no-op and still consumes the op's one audit", async () => {
    const audit = auditWith([]);
    const r = await runSpecAuditGate(op("c"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(false);
    await runSpecAuditGate(op("c"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(audit).toHaveBeenCalledOnce();
  });

  it("a null verdict (classifier down / unparseable) degrades to a no-op, never a nudge", async () => {
    const audit = auditWith(null);
    const r = await runSpecAuditGate(op("d"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(false);
    expect(r.nudge).toBe("");
  });

  it("no edited paths / too-short request → no-op before any evidence or LLM work", async () => {
    const audit = auditWith(["item"]);
    const r1 = await runSpecAuditGate(op("e"), { editedPaths: [], collectEvidence: evidenceOk, audit });
    expect(r1.shouldRetry).toBe(false);
    (opRequestText as ReturnType<typeof vi.fn>).mockReturnValue("fix");
    const r2 = await runSpecAuditGate(op("f"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r2.shouldRetry).toBe(false);
    expect(evidenceOk).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("empty/failed evidence is a no-op that does NOT consume the audit (transient git failure)", async () => {
    const audit = auditWith(["item"]);
    const empty = vi.fn(async () => "");
    const r = await runSpecAuditGate(op("g"), { editedPaths: PATHS, collectEvidence: empty, audit });
    expect(r.shouldRetry).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    // evidence recovers → the audit still gets its one shot
    const r2 = await runSpecAuditGate(op("g"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r2.shouldRetry).toBe(true);
    // a throwing collector is equally safe
    const boom = vi.fn(async () => { throw new Error("git exploded"); });
    const r3 = await runSpecAuditGate(op("h"), { editedPaths: PATHS, collectEvidence: boom, audit });
    expect(r3.shouldRetry).toBe(false);
  });

  it("clearSpecAuditStateForOp re-arms the op", async () => {
    const audit = auditWith(["item"]);
    await runSpecAuditGate(op("i"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    clearSpecAuditStateForOp("i");
    const r = await runSpecAuditGate(op("i"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    expect(r.shouldRetry).toBe(true);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("applied redirect instructions are audited as amendments to the request", async () => {
    // 2026-07-13: "make sure its not dark theme" arrived as a redirect, was
    // consumed, and vanished — the audit re-read only the opening prompt and
    // returned MET on a worker that never made the edit. Amendments must be
    // part of the audited request.
    (appliedRedirectTexts as ReturnType<typeof vi.fn>).mockReturnValue([
      "make sure its not dark theme",
      "give it a custom background",
    ]);
    const audit = auditWith([]);
    await runSpecAuditGate(op("j"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    const { userRequest } = (audit.mock.calls[0] as unknown as [{ userRequest: string }])[0];
    expect(userRequest).toContain("Remove every tailnet reference");
    expect(userRequest).toContain("Mid-build user amendments");
    expect(userRequest).toContain("1. make sure its not dark theme");
    expect(userRequest).toContain("2. give it a custom background");
  });

  it("no applied redirects → the audited request is the first message alone", async () => {
    const audit = auditWith([]);
    await runSpecAuditGate(op("k"), { editedPaths: PATHS, collectEvidence: evidenceOk, audit });
    const { userRequest } = (audit.mock.calls[0] as unknown as [{ userRequest: string }])[0];
    expect(userRequest).toBe("Remove every tailnet reference from the app");
    expect(userRequest).not.toContain("amendments");
  });
});
