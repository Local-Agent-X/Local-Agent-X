// Key-shaped text in what a publish would ship: only added lines are judged,
// each finding names the file and the line in the new file, and any finding
// makes the review RED.
import { describe, expect, it } from "vitest";
import { addedLinesOf, keyFindings, withKeyFindings } from "./publish-key-findings.js";
import type { ChangeSet } from "../publish-review/change-set-types.js";
import type { PublishReview } from "../canonical-loop/public/publish-review.js";

// Assembled at runtime so the repo's own scanners do not flag this file.
const KEY = `ghp_${"abcdefghijklmnopqrstuvwxyz1234567890"}`;

function diff(path: string, hunks: string): string {
  return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n${hunks}`;
}

function changeSet(files: Array<{ path: string; text: string }>, kind: "git-push" | "deploy" = "git-push"): ChangeSet {
  return {
    parts: [{
      kind, label: kind === "git-push" ? "git push origin main" : "firebase deploy", repoRoot: "/repo",
      baseLabel: "origin/main", commits: [{ sha: "c".repeat(40), subject: "config" }], commitsTruncated: false,
      files: files.map((f) => ({ status: "M", path: f.path })), fileDiffs: files, diffTruncated: false,
      includesWorkingTree: false, identity: "id",
    }],
    unknown: [],
    fingerprint: "fp",
  } as ChangeSet;
}

const green: PublishReview = { status: "GREEN", findings: [], fingerprint: "fp", summary: "1 commit", unknown: [] };

describe("addedLinesOf", () => {
  it("takes added lines only, numbered as in the new file, across hunks", () => {
    const text = diff("a.ts", [
      "@@ -10,3 +10,4 @@ fn",
      " keep",
      "-gone",
      "+first",
      "+second",
      " keep",
      "@@ -40,2 +41,3 @@",
      " keep",
      "+third",
      "\\ No newline at end of file",
    ].join("\n"));
    expect(addedLinesOf(text)).toEqual({ text: "first\nsecond\nthird", lineNumbers: [11, 12, 42] });
  });

  it("does not read a file header as an added line, and survives a blank context line", () => {
    const text = diff("a.ts", "@@ -1,3 +1,4 @@\n one\n\n+added\n three");
    expect(addedLinesOf(text)).toEqual({ text: "added", lineNumbers: [3] });
  });
});

describe("keyFindings", () => {
  it("names the file and line of a key the change adds, and what it is attached to, masked", () => {
    const cs = changeSet([{ path: "src/config.ts", text: diff("src/config.ts", `@@ -3,2 +3,3 @@\n const a = 1;\n+const token = "${KEY}";\n const b = 2;`) }]);
    const [finding, ...rest] = keyFindings(cs);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ severity: "red", location: "src/config.ts:4" });
    expect(finding.problem).toMatch(/could be a password or access key/);
    expect(finding.problem).toContain("token = ");
    expect(finding.problem).not.toContain(KEY);
    expect(finding.why).toContain("repository");
    expect(finding.fix).toMatch(/publish again unchanged and the user decides/);
  });

  it("ignores a key the change removes or only passes by, and text that is not one", () => {
    const cs = changeSet([
      { path: "old.ts", text: diff("old.ts", `@@ -1,2 +1,1 @@\n-const token = "${KEY}";\n keep`) },
      { path: "ctx.ts", text: diff("ctx.ts", `@@ -1,2 +1,3 @@\n const token = "${KEY}";\n+const n = 1;\n keep`) },
      { path: "data.json", text: diff("data.json", `@@ -1,1 +1,2 @@\n {\n+  "url": "https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/"`) },
    ]);
    expect(keyFindings(cs)).toEqual([]);
  });

  it("does not judge stylesheets and SVG, and says site for a deploy", () => {
    const hunk = `@@ -1,1 +1,2 @@\n a\n+token = "${KEY}"`;
    expect(keyFindings(changeSet([{ path: "a.svg", text: diff("a.svg", hunk) }]))).toEqual([]);
    expect(keyFindings(changeSet([{ path: "a.env", text: diff("a.env", hunk) }], "deploy"))[0].why).toContain("site or package");
  });

  it("names the first few and counts the rest", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `+k${i} = "ghp_${String(i).repeat(36)}"`).join("\n");
    const found = keyFindings(changeSet([{ path: "keys.env", text: diff("keys.env", `@@ -0,0 +1,8 @@\n${lines}`) }]));
    expect(found).toHaveLength(5);
    expect(found[4].problem).toContain("And 3 more like it");
  });
});

describe("withKeyFindings", () => {
  const withKey = changeSet([{ path: ".env", text: diff(".env", `@@ -0,0 +1,1 @@\n+API_TOKEN=${KEY}`) }]);

  it("turns a GREEN review RED, key findings first", () => {
    const amber: PublishReview = { ...green, status: "AMBER", findings: [{ severity: "amber", location: "a.ts:1", problem: "p", why: "w", fix: "f" }] };
    const out = withKeyFindings(amber, withKey);
    expect(out.status).toBe("RED");
    expect(out.findings.map((f) => f.location)).toEqual([".env:1", "a.ts:1"]);
  });

  it("does not let a review that could not run wave a key through", () => {
    const failed: PublishReview = { ...green, status: "FAILED", reason: "timed out" };
    expect(withKeyFindings(failed, withKey)).toMatchObject({ status: "RED", reason: "timed out" });
  });

  it("leaves a review alone when the change adds nothing key-shaped", () => {
    expect(withKeyFindings(green, changeSet([{ path: "a.ts", text: diff("a.ts", "@@ -1,1 +1,2 @@\n a\n+const n = 1;") }]))).toBe(green);
  });
});
