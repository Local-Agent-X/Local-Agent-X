import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classLevelNameProblem,
  derivabilityProblem,
  workspaceProjectNames,
} from "./learned-proposal-gate.js";

const BODY = [
  "## Preconditions",
  "- Logged into Vercel as the team owner",
  "## Steps",
  "1. Settings > Domains > Add — the field is labelled \"Domain\", not \"Hostname\"",
  "## Pitfalls",
  "- The first attempt used the project-level page, which only lists domains; adding happens at team level.",
].join("\n");

const BROWSER_RUN = ["browser", "browser", "read", "write"];
const LOCAL_RUN = ["bash", "read", "edit", "bash"];

describe("derivability: a proposal must name what the agent could not have derived", () => {
  it("refuses a proposal with no learned claim", () => {
    expect(derivabilityProblem(undefined, BODY, BROWSER_RUN)).toContain("could not have derived");
  });

  it("refuses an unknown kind, a short detail, and a detail the body does not carry", () => {
    expect(derivabilityProblem({ kind: "fact" as never, detail: "Settings > Domains > Add" }, BODY, BROWSER_RUN)).toContain("learned.kind");
    expect(derivabilityProblem({ kind: "pitfall", detail: "team" }, BODY, BROWSER_RUN)).toContain("quote the specific");
    expect(derivabilityProblem({ kind: "external_string", detail: "Settings > Domains > Remove" }, BODY, BROWSER_RUN)).toContain("verbatim");
  });

  it("accepts a detail quoted from the body, whatever the whitespace and case", () => {
    expect(derivabilityProblem({ kind: "external_string", detail: "settings > domains >   add" }, BODY, BROWSER_RUN)).toBeNull();
    expect(derivabilityProblem({ kind: "pitfall", detail: "adding happens at team level" }, BODY, BROWSER_RUN)).toBeNull();
  });

  it("refuses an external claim from a run that never reached an external system", () => {
    const pushBody = "## Steps\n1. git push origin master from the repo root\n## Pitfalls\n- master is protected; push to a branch and open a PR";
    expect(derivabilityProblem({ kind: "external_string", detail: "git push origin master" }, pushBody, LOCAL_RUN)).toContain("never called a tool that reaches one");
    expect(derivabilityProblem({ kind: "precondition", detail: "git push origin master" }, pushBody, LOCAL_RUN)).toContain("never called a tool that reaches one");
    expect(derivabilityProblem({ kind: "external_string", detail: "git push origin master" }, pushBody, ["bash", "http_request", "read", "bash"])).toBeNull();
    expect(derivabilityProblem({ kind: "external_string", detail: "git push origin master" }, pushBody, ["bash", "browser_navigate", "read", "bash"])).toBeNull();
  });

  it("still lets a local-only run record a pitfall or a user correction", () => {
    const pushBody = "## Pitfalls\n- master is protected; push to a branch and open a PR";
    expect(derivabilityProblem({ kind: "pitfall", detail: "master is protected; push to a branch" }, pushBody, LOCAL_RUN)).toBeNull();
    expect(derivabilityProblem({ kind: "user_correction", detail: "push to a branch and open a PR" }, pushBody, LOCAL_RUN)).toBeNull();
  });
});

describe("class-level names", () => {
  const PROJECTS = ["jobs_in_order", "scanprogress", "studio_ops"];

  it("accepts a name that says the class of work and the system it drives", () => {
    expect(classLevelNameProblem("vercel_custom_domain_link", PROJECTS)).toBeNull();
    expect(classLevelNameProblem("thriveventory_purchase_order", PROJECTS)).toBeNull();
    expect(classLevelNameProblem("jobs_board_post", PROJECTS)).toBeNull();
  });

  it("refuses a name carrying a workspace project, matched as whole segments", () => {
    expect(classLevelNameProblem("jobs_in_order_crm_master_push", PROJECTS)).toContain("jobs_in_order");
    expect(classLevelNameProblem("scanprogress_mobile_emulator_test", PROJECTS)).toContain("scanprogress");
    expect(classLevelNameProblem("vercel_scanprogress_account_login", PROJECTS)).toContain("scanprogress");
    expect(classLevelNameProblem("scanprogressive_rollout", PROJECTS)).toBeNull();
  });

  it("refuses a session-artifact name", () => {
    for (const name of ["site_clone_seo_parity_audit", "zoom_recording_debrief", "repo_build_error_triage", "static_site_style_forensics", "nextjs_demo_walkthrough"]) {
      expect(classLevelNameProblem(name, []), name).not.toBeNull();
    }
  });
});

describe("workspace project names", () => {
  it("lists directories under the root and under apps/, normalized to slug segments", () => {
    const root = mkdtempSync(join(tmpdir(), "lax-gate-"));
    try {
      for (const dir of ["Jobs-In-Order", "scanprogress-src", "apps/studio ops", ".git", "ab"]) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, "notes.txt"), "");
      expect(workspaceProjectNames(root).sort()).toEqual(["jobs_in_order", "scanprogress_src", "studio_ops"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is empty for a workspace that does not exist", () => {
    expect(workspaceProjectNames(join(tmpdir(), "lax-gate-missing-" + Date.now()))).toEqual([]);
  });
});
