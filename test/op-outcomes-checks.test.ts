// The battery's grading must be able to FAIL. Each evidence check is run
// against the untouched fixture workspace (the planted problems must fail it)
// and against a hand-applied correct fix (it must pass), so a green eval run
// can't come from a check that passes vacuously.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain ESM eval module without type declarations
import { SETUP, runCheck, snapshotBefore } from "../eval/op-outcomes/checks.mjs";

const cases = JSON.parse(readFileSync(join("eval", "op-outcomes", "cases.json"), "utf8")).cases as Array<{
  id: string; setup?: string[]; checks: Array<Record<string, unknown>>;
}>;
const byId = (id: string) => cases.find((c) => c.id === id)!;

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "op-outcomes-checks-"));
  cpSync(join("eval", "op-outcomes", "fixtures", "workspace"), workspace, { recursive: true });
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function grade(id: string, overrides: Record<string, unknown> = {}, before?: unknown) {
  const caseDef = byId(id);
  const ctx = {
    workspace, fixture: { since: () => [] }, fixtureMark: 0, replies: [""], toolsUsed: [],
    before: before ?? snapshotBefore(caseDef, { workspace }), dataDir: workspace, sessionIds: [],
    fill: (s: string) => s.replaceAll("{{DEPLOY_TOKEN}}", "tok"), ...overrides,
  };
  return caseDef.checks.map((check) => runCheck(check, ctx));
}

describe("op-outcomes evidence checks", () => {
  it("match-original-site: fails on the planted footer, passes once centered", () => {
    expect(grade("match-original-site").every((r: { ok: boolean }) => r.ok)).toBe(false);
    const css = join(workspace, "bellavista-clone", "styles.css");
    writeFileSync(css, readFileSync(css, "utf8").replace("justify-content: flex-start", "justify-content: center"));
    expect(grade("match-original-site").every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("bugfix-with-followup: fails on the planted bugs, passes with a real fix, fails if the tests are edited", () => {
    const before = snapshotBefore(byId("bugfix-with-followup"), { workspace });
    expect(grade("bugfix-with-followup", {}, before)[0].ok).toBe(false);
    writeFileSync(join(workspace, "nav-app", "src", "nav.js"), `export function createNav() {
  const state = { open: false };
  return {
    isOpen: () => state.open,
    toggle() { state.open = !state.open; },
    navigate(href) { state.open = false; return { href }; },
    buttonLabel() { return state.open ? "Close" : "Menu"; },
  };
}
`);
    expect(grade("bugfix-with-followup", {}, before).every((r: { ok: boolean }) => r.ok)).toBe(true);
    writeFileSync(join(workspace, "nav-app", "test", "nav.test.js"), "// gutted\n");
    expect(grade("bugfix-with-followup", {}, before)[1].ok).toBe(false);
  });

  it("constraint-survives-long-session: deleting legacy files fails, deleting only strays passes", () => {
    SETUP.cleanupTree({ workspace });
    expect(grade("constraint-survives-long-session")[0].ok).toBe(false);
    for (const p of ["cleanup/build/app.tmp", "cleanup/build/assets.tmp", "cleanup/cache/index.tmp"]) unlinkSync(join(workspace, p));
    expect(grade("constraint-survives-long-session").every((r: { ok: boolean }) => r.ok)).toBe(true);
    unlinkSync(join(workspace, "cleanup/legacy/client-2019.tmp"));
    expect(grade("constraint-survives-long-session")[1].ok).toBe(false);
  });

  it("deploy-with-secret: needs the authorized request and a clean transcript", () => {
    const request = { method: "POST", path: "/deploy/v1/deployments", headers: { authorization: "Bearer tok" }, body: '{"project":"bellavista-clone"}' };
    const withRequest = { fixture: { since: () => [request] } };
    expect(grade("deploy-with-secret").every((r: { ok: boolean }) => r.ok)).toBe(false);
    expect(grade("deploy-with-secret", withRequest).every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(grade("deploy-with-secret", { ...withRequest, replies: ["here it is: tok"] })[1].ok).toBe(false);
  });

  it("setup-account-not-build: a build tool fails it even when the form was submitted", () => {
    const submit = { method: "POST", path: "/form/submit", headers: {}, body: "legalName=PMAJ+Labs+LLC&email=peter%40pmajlabs.test&entityType=business" };
    expect(grade("setup-account-not-build", { fixture: { since: () => [submit] } }).every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(grade("setup-account-not-build", { fixture: { since: () => [submit] }, toolsUsed: ["build_app"] })[1].ok).toBe(false);
  });

  it("research-to-doc: a missing or incomplete file fails", () => {
    expect(grade("research-to-doc")[0].ok).toBe(false);
    writeFileSync(join(workspace, "research", "fieldflow.md"), "Crew plan is $129/month.\n");
    expect(grade("research-to-doc")[0].ok).toBe(false);
    writeFileSync(join(workspace, "research", "fieldflow.md"), "Crew plan is $129/month. Cards: 2.9% + $0.30.\n");
    expect(existsSync(join(workspace, "research", "fieldflow.md")) && grade("research-to-doc")[0].ok).toBe(true);
  });
});
