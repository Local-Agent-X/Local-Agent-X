import { describe, it, expect } from "vitest";
import { buildPublishReviewBrief, MAX_DIFF_CHARS, summarizeChangeSet } from "./publish-review-brief.js";
import type { ChangeSet, ChangeSetPart } from "../publish-review/change-set-types.js";

function part(over: Partial<ChangeSetPart> = {}): ChangeSetPart {
  return {
    kind: "git-push",
    label: "git push origin feature",
    repoRoot: "/repo",
    refs: [{ remoteRef: "refs/heads/feature", localRef: "refs/heads/feature", status: "new", newSha: "a".repeat(40) }],
    baseLabel: "the merge-base with origin/main",
    commits: [{ sha: "a".repeat(40), subject: "add email digest" }],
    commitsTruncated: false,
    files: [{ status: "A", path: "src/digest.ts" }, { status: "A", path: "supabase/migrations/0042_email_rls.sql" }],
    fileDiffs: [
      { path: "src/digest.ts", text: "diff --git a/src/digest.ts b/src/digest.ts\n+export const digest = 1;\n" },
      { path: "supabase/migrations/0042_email_rls.sql", text: "diff --git a/supabase/migrations/0042_email_rls.sql b/supabase/migrations/0042_email_rls.sql\n+create policy read_all on emails for select using (true);\n" },
    ],
    diffTruncated: false,
    includesWorkingTree: false,
    identity: "x",
    ...over,
  };
}

const cs = (parts: ChangeSetPart[], unknown: ChangeSet["unknown"] = []): ChangeSet => ({ parts, unknown, fingerprint: "f" });

describe("buildPublishReviewBrief", () => {
  it("carries the mandate, what ships, the diff and the verbatim output contract", () => {
    const brief = buildPublishReviewBrief(cs([part()]));
    expect(brief).toContain("Line 1: VERDICT: RED | AMBER | GREEN");
    expect(brief).toContain("SEVERITY | path:line | problem | why it matters | fix");
    expect(brief).toContain("grep this repository for how it already solved the same problem");
    expect(brief).toContain("Repository root: /repo");
    expect(brief).toContain("refs/heads/feature: new");
    expect(brief).toContain("add email digest");
    expect(brief).toContain("+create policy read_all on emails");
  });

  it("shows access-policy and migration files before ordinary code", () => {
    const brief = buildPublishReviewBrief(cs([part()]));
    expect(brief.indexOf("+create policy read_all")).toBeLessThan(brief.indexOf("+export const digest"));
  });

  it("bounds the diff but never drops the file list, and names what it cut", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({
      path: `src/file${i}.ts`,
      text: `diff --git a/src/file${i}.ts b/src/file${i}.ts\n${"+x\n".repeat(2_000)}`,
    }));
    const brief = buildPublishReviewBrief(cs([part({ files: big.map((d) => ({ status: "M", path: d.path })), fileDiffs: big })]));
    for (const d of big) expect(brief).toContain(`M\t${d.path}`);
    expect(brief).toContain("cut here — read the file");
    expect(brief).toMatch(/Not shown \(read these files\): .*src\/file39\.ts/);
    expect(brief.length).toBeLessThan(MAX_DIFF_CHARS + 20_000);
  });

  it("tells the reviewer the working tree ships for a deploy", () => {
    expect(buildPublishReviewBrief(cs([part({ kind: "deploy", includesWorkingTree: true, refs: undefined })]))).toContain("The working tree ships");
  });

  it("lists publishes that could not be reviewed", () => {
    const brief = buildPublishReviewBrief(cs([part()], [{ label: "vercel --prod", cwd: "/site", reason: "/site is not inside a git repository" }]));
    expect(brief).toContain("NOT reviewable: vercel --prod (/site is not inside a git repository)");
  });
});

describe("summarizeChangeSet", () => {
  it("counts commits and files and names the command and repository", () => {
    expect(summarizeChangeSet(cs([part()]))).toBe("1 commit, 2 files — git push origin feature from /repo");
  });
});
