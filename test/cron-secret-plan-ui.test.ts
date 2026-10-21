// @vitest-environment happy-dom
//
// The Missions page's "Keys this job may use" (public/js/cron-secret-plan.js):
// the editor in the New Mission and edit forms picks a saved key by name, puts
// the key's saved site in the site box, and hands the save body the plan; the
// detail view lists every job's plan with Remove, which PATCHes the job
// without that pair. Names and sites only: the page never asks for a value.
//
// A classic global script, so — like test/cron-detail-transcript-view.test.ts —
// its source runs in a Function factory with the globals it reaches for passed in.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../public/js/cron-secret-plan.js"), "utf8");
const esc = (value: unknown) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

type Win = Window & Record<string, (...args: never[]) => unknown>;
const VAULT = [
  { name: "SUPABASE_MGMT_TOKEN", origin: "https://supabase.com", approvedDestinations: [{ origin: "https://api.supabase.com" }] },
  { name: "GITHUB_TOKEN" },
];

let apiJson: ReturnType<typeof vi.fn>;
let refresh: ReturnType<typeof vi.fn>;
let jobs: Array<Record<string, unknown>>;

function load(): Win {
  apiJson = vi.fn(async (path: string, opts?: { method?: string }) => {
    if (path === "/api/secrets") return VAULT;
    if (opts?.method === "PATCH") return { ok: true, job: {} };
    throw new Error(`unexpected fetch: ${path}`);
  });
  refresh = vi.fn(async () => undefined);
  new Function("apiJson", "esc", "alert", "confirm", "cronJobs", "refreshSelectedCronJob", source)(
    apiJson, esc, vi.fn(), () => true, jobs, refresh,
  );
  return window as unknown as Win;
}

const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
const setValue = (id: string, v: string) => { (document.getElementById(id) as HTMLInputElement).value = v; };

beforeEach(() => {
  document.body.innerHTML = '<div id="new-cron-keys"></div><div id="cron-detail-keys"></div>';
  jobs = [];
});

describe("the key plan editor", () => {
  it("offers the saved keys by name and puts the picked key's saved site in the site box", async () => {
    const w = load();
    await w.mountCronSecretPlan("new-cron-keys", []);
    const names = [...document.querySelectorAll("#new-cron-keys-key option")].map((o) => (o as HTMLOptionElement).value);
    expect(names).toEqual(["", "SUPABASE_MGMT_TOKEN", "GITHUB_TOKEN"]);
    setValue("new-cron-keys-key", "SUPABASE_MGMT_TOKEN");
    w.cronSecretPlanPickKey("new-cron-keys");
    expect(value("new-cron-keys-site")).toBe("https://supabase.com");
    const suggested = [...document.querySelectorAll("#new-cron-keys-sites option")].map((o) => (o as HTMLOptionElement).value);
    expect(suggested).toEqual(["https://supabase.com", "https://api.supabase.com"]);
    expect(apiJson.mock.calls.map((c) => c[0])).toEqual(["/api/secrets"]);
  });

  it("adds an edited site as its origin, once, and removes a pair", async () => {
    const w = load();
    await w.mountCronSecretPlan("new-cron-keys", [{ name: "GITHUB_TOKEN", destination: "https://api.github.com" }]);
    setValue("new-cron-keys-key", "SUPABASE_MGMT_TOKEN");
    setValue("new-cron-keys-site", "api.supabase.com/v1/projects");
    w.cronSecretPlanAdd("new-cron-keys");
    setValue("new-cron-keys-key", "SUPABASE_MGMT_TOKEN");
    setValue("new-cron-keys-site", "https://api.supabase.com");
    w.cronSecretPlanAdd("new-cron-keys");
    expect(w.cronSecretPlanOf("new-cron-keys")).toEqual([
      { name: "GITHUB_TOKEN", destination: "https://api.github.com" },
      { name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" },
    ]);
    expect(document.getElementById("new-cron-keys")!.textContent).toContain("SUPABASE_MGMT_TOKEN");
    w.cronSecretPlanRemove("new-cron-keys", 0);
    expect(w.cronSecretPlanOf("new-cron-keys")).toEqual([{ name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" }]);
  });
});

describe("the detail view", () => {
  it("lists the job's plan, and Remove saves the job without that pair", async () => {
    const plan = [
      { name: "SUPABASE_MGMT_TOKEN", destination: "https://api.supabase.com" },
      { name: "GITHUB_TOKEN", destination: "https://api.github.com" },
    ];
    jobs.push({ id: "cron_abc", name: "Nightly", secretPlan: plan });
    const w = load();
    w.renderCronSecretPlanDetail(jobs[0] as never);
    const text = document.getElementById("cron-detail-keys")!.textContent!;
    expect(text).toContain("SUPABASE_MGMT_TOKEN");
    expect(text).toContain("https://api.github.com");
    await w.removeCronPlanPair("cron_abc" as never, 0 as never);
    const patch = apiJson.mock.calls.find((c) => c[1]?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/cron/cron_abc");
    expect(JSON.parse(patch[1].body)).toEqual({ secretPlan: [plan[1]] });
    expect(refresh).toHaveBeenCalled();
  });

  it("says a job with no plan asks in the inbox", () => {
    const w = load();
    w.renderCronSecretPlanDetail({ id: "j", name: "n" } as never);
    expect(document.getElementById("cron-detail-keys")!.textContent).toContain("asks in your inbox");
  });
});
