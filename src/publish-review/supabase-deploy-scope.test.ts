/**
 * `supabase functions deploy send-push-notification` uploads that one function with
 * the local code it imports, and its review covered the project's whole tree: a
 * week-old account-deletion migration and its handoff notes, whose findings blocked
 * every deploy of a push fix that shipped neither (Scan Progress, 2026-11-26). The
 * review now reads what the deploy uploads, and the whole tree whenever it cannot
 * name that for certain. Real git in a temp directory, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChangeSet } from "./change-set.js";
import { supabaseDeployPaths } from "./supabase-deploy-scope.js";
import { publishOperations } from "../publish-operation.js";

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(file: string, content: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
}

function deployOp(command: string) {
  const [op] = publishOperations("bash", { command, cwd: repo });
  expect(op?.kind).toBe("deploy");
  return op;
}

const reviewed = async (command: string): Promise<string[]> =>
  (await computeChangeSet([deployOp(command)])).parts[0].files.map((f) => f.path).sort();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "lax-supabase-scope-"));
  git("init", "-q", "-b", "main");
  write("supabase/config.toml", "project_id = \"scan\"\n");
  write("supabase/functions/send-push-notification/index.ts", "import { sendExpoPush } from './expo.ts';\nimport { cors } from '../_shared/cors.ts';\nimport { createClient } from 'npm:@supabase/supabase-js@2';\nexport { sendExpoPush, cors, createClient };\n");
  write("supabase/functions/send-push-notification/expo.ts", "export const sendExpoPush = 1;\n");
  write("supabase/functions/_shared/cors.ts", "export const cors = {};\n");
  write("supabase/functions/_shared/unused.ts", "export const unused = 1;\n");
  write("supabase/functions/send-sms/index.ts", "export const sms = 1;\n");
  write("supabase/migrations/20261120_1_deletion_requests.sql", "create table deletion_requests (id uuid);\n");
  write("docs/handoff/2026-11-20-admin-delete-member.md", "Deleted member: someone\n");
  write("apps/web/src/app.ts", "export const app = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "app");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("supabase deploys: the command names what they upload", () => {
  it("reads the functions named, past the flags and their values", () => {
    expect(deployOp("npx -y supabase@latest functions deploy send-push-notification --project-ref kybhkldvgdezjrwnmmyr --use-api 2>&1 | tail -20").uploads)
      .toEqual({ tool: "supabase", what: "functions", names: ["send-push-notification"] });
    expect(deployOp("supabase functions deploy --project-ref p a b").uploads).toEqual({ tool: "supabase", what: "functions", names: ["a", "b"] });
    expect(deployOp("supabase functions deploy --workdir apps/api").uploads).toEqual({ tool: "supabase", what: "functions", names: [], workdir: "apps/api" });
    expect(deployOp("supabase db push --linked").uploads).toEqual({ tool: "supabase", what: "migrations" });
  });

  it("names none when a flag sends more than that", () => {
    expect(deployOp("supabase functions deploy x --import-map ./map.json").uploads).toBeUndefined();
    expect(deployOp("supabase db push --include-seed").uploads).toBeUndefined();
    expect(deployOp("supabase db push --include-roles").uploads).toBeUndefined();
  });
});

describe("supabase functions deploy <name>: the review reads that function and what it imports", () => {
  it("reviews the function, the shared file it imports and config.toml, not the migration, the handoff or the app", async () => {
    expect(await reviewed("supabase functions deploy send-push-notification --project-ref p")).toEqual([
      "supabase/config.toml",
      "supabase/functions/_shared/cors.ts",
      "supabase/functions/send-push-notification/expo.ts",
      "supabase/functions/send-push-notification/index.ts",
    ]);
  });

  it("an uncommitted edit to the function is in the scope; one to a migration is not", async () => {
    write("supabase/functions/send-push-notification/expo.ts", "export const sendExpoPush = 2;\n");
    write("supabase/migrations/20261126_x.sql", "select 1;\n");
    expect(await reviewed("supabase functions deploy send-push-notification")).toContain("supabase/functions/send-push-notification/expo.ts");
    expect(await reviewed("supabase functions deploy send-push-notification")).not.toContain("supabase/migrations/20261126_x.sql");
  });

  it("every function when none is named, and still no migration", async () => {
    const files = await reviewed("supabase functions deploy");
    expect(files).toContain("supabase/functions/send-sms/index.ts");
    expect(files).not.toContain("supabase/migrations/20261120_1_deletion_requests.sql");
  });

  it("db push reviews the migrations and config.toml only", async () => {
    expect(await reviewed("supabase db push")).toEqual(["supabase/config.toml", "supabase/migrations/20261120_1_deletion_requests.sql"]);
  });
});

describe("supabase deploys: the whole tree whenever the upload cannot be named", () => {
  const functions = { tool: "supabase" as const, what: "functions" as const, names: ["send-push-notification"] };

  it("a function that is not there", async () => {
    expect(await supabaseDeployPaths(repo, repo, { ...functions, names: ["gone"] })).toBeNull();
  });

  it("config.toml setting a function's own files", async () => {
    write("supabase/config.toml", "[functions.send-push-notification]\nstatic_files = [\"./assets/*\"]\n");
    expect(await supabaseDeployPaths(repo, repo, functions)).toBeNull();
  });

  it("an import map that points at local files", async () => {
    write("supabase/functions/deno.json", "{\"imports\": {\"@shared/\": \"./_shared/\"}}\n");
    expect(await supabaseDeployPaths(repo, repo, functions)).toBeNull();
  });

  it("an import that leaves the repository", async () => {
    write("supabase/functions/send-push-notification/expo.ts", "import '../../../../outside.ts';\n");
    expect(await supabaseDeployPaths(repo, repo, functions)).toBeNull();
  });

  it("no supabase folder where it runs", async () => {
    expect(await supabaseDeployPaths(join(repo, "apps"), repo, functions)).toBeNull();
  });

  it("an import map with only remote packages keeps the scope, and is in it", async () => {
    write("supabase/functions/deno.json", "{\"imports\": {\"zod\": \"npm:zod@3\"}}\n");
    expect(await supabaseDeployPaths(repo, repo, functions)).toContain("supabase/functions/deno.json");
  });
});
