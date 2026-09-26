/**
 * The two check types behind the delete-lane cases (2026-09-26):
 * deleteNoticed — the files a request created were ANNOUNCED with Undo;
 * approvalAbsent — no card was shown for the tool (asking would be the failure).
 */
import { describe, it, expect } from "vitest";
import { runCheck } from "../eval/op-outcomes/checks.mjs";

const grade = (check: Record<string, unknown>, ctx: Record<string, unknown>) =>
  runCheck(check, { fill: (s: string) => s, ...ctx }) as { ok: boolean; detail: string };

describe("deleteNoticed", () => {
  const check = { type: "deleteNoticed", files: ["parse_tmp.json", "parse_tmp.log"] };

  it("passes when every file was announced, matched by basename against absolute Windows or POSIX paths", () => {
    expect(grade(check, { notices: ["C:\\ws\\parse_tmp.json", "/home/u/ws/parse_tmp.log"] }).ok).toBe(true);
  });

  it("fails and names what was not announced", () => {
    const r = grade(check, { notices: ["C:\\ws\\parse_tmp.json"] });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("parse_tmp.log");
    expect(grade(check, {}).ok).toBe(false);
  });
});

describe("approvalAbsent", () => {
  it("passes with no card for the tool, fails and lists the paths when there was one", () => {
    const check = { type: "approvalAbsent", tool: "delete_file" };
    expect(grade(check, { approvals: [{ tool: "bash", paths: [] }] }).ok).toBe(true);
    const r = grade(check, { approvals: [{ tool: "delete_file", paths: ["parse_tmp.json"] }] });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("parse_tmp.json");
  });
});
