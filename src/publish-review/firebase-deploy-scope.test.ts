/**
 * `firebase deploy --only remoteconfig` uploads one template, and its review
 * covered the project's whole tree: 62 commits, 121 files and a lockfile whose
 * every integrity line read as a key (label-check, 2026-11-23). The review now
 * reads what the targets upload, and the whole tree whenever it cannot name
 * that for certain. Real git in a temp directory, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeChangeSet } from "./change-set.js";
import { firebaseDeployPaths } from "./firebase-deploy-scope.js";
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

const FIREBASE_JSON = JSON.stringify({
  hosting: { public: "dist" },
  remoteconfig: { template: "remoteconfig.template.json" },
  firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" },
  storage: [{ bucket: "a", rules: "storage.rules" }, { bucket: "b", rules: "rules/b.rules" }],
});

/** The deploy as the shell walk parses it from a command line. */
function deployOp(command: string, cwd = repo) {
  const [op] = publishOperations("bash", { command, cwd });
  expect(op?.kind).toBe("deploy");
  return op;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "lax-firebase-scope-"));
  git("init", "-q", "-b", "main");
  write("firebase.json", FIREBASE_JSON);
  write("remoteconfig.template.json", '{"parameters":{"disclaimer_text":{"defaultValue":{"value":"Ask your pharmacist."}}}}\n');
  write("firestore.rules", "rules_version = '2';\n");
  write("firestore.indexes.json", "{}\n");
  write("storage.rules", "rules_version = '2';\n");
  write("rules/b.rules", "rules_version = '2';\n");
  write("package-lock.json", '{"integrity": "sha512-6OzddxPio9UiWTCemp4N8cYLV2ZN1ncRnV1cVGtve7dhPOtRkleRyx32GQCYSwDYgaHU3USMm84tNsvKzRCa1Q=="}\n');
  write("src/app.ts", "export const app = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "app");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("firebase deploy --only: the review reads what the targets upload", () => {
  it("the command line names the targets, with or without =, past other flags", () => {
    expect(deployOp("firebase deploy --only remoteconfig --project label-check-pmaj --non-interactive").uploads).toEqual({ tool: "firebase", only: ["remoteconfig"] });
    expect(deployOp("npx firebase deploy --only=firestore:rules,storage").uploads).toEqual({ tool: "firebase", only: ["firestore:rules", "storage"] });
    expect(deployOp("firebase deploy").uploads).toBeUndefined();
    // Another config file: its targets are not looked up.
    expect(deployOp("firebase deploy --only remoteconfig --config other.json").uploads).toBeUndefined();
  });

  it("--only remoteconfig reviews the template and firebase.json, not the lockfile or the source", async () => {
    const cs = await computeChangeSet([deployOp("firebase deploy --only remoteconfig --project p 2>&1 | tail -8")]);
    const [part] = cs.parts;
    expect(part.files.map((f) => f.path).sort()).toEqual(["firebase.json", "remoteconfig.template.json"]);
    expect(part.fileDiffs.map((d) => d.path).sort()).toEqual(["firebase.json", "remoteconfig.template.json"]);
    expect(part.baseLabel).toContain("limited to what firebase deploy uploads");
  });

  it("an uncommitted or untracked template is in the scope; other edits are not", async () => {
    write("remoteconfig.template.json", '{"parameters":{}}\n');
    write("src/new.ts", "export const n = 1;\n");
    const [part] = (await computeChangeSet([deployOp("firebase deploy --only remoteconfig")])).parts;
    expect(part.files.map((f) => f.path).sort()).toEqual(["firebase.json", "remoteconfig.template.json"]);
  });

  it("an edit to the template changes the fingerprint; an edit elsewhere does not", async () => {
    const op = deployOp("firebase deploy --only remoteconfig");
    const a = await computeChangeSet([op]);
    write("src/app.ts", "export const app = 2;\n");
    expect((await computeChangeSet([op])).fingerprint).toBe(a.fingerprint);
    write("remoteconfig.template.json", '{"parameters":{"x":{}}}\n');
    expect((await computeChangeSet([op])).fingerprint).not.toBe(a.fingerprint);
  });

  it("firestore, firestore:rules, and every bucket of a storage list", async () => {
    expect(await firebaseDeployPaths(repo, repo, ["firestore"])).toEqual(["firebase.json", "firestore.rules", "firestore.indexes.json"]);
    expect(await firebaseDeployPaths(repo, repo, ["firestore:rules"])).toEqual(["firebase.json", "firestore.rules"]);
    expect(await firebaseDeployPaths(repo, repo, ["storage:a"])).toEqual(["firebase.json", "storage.rules", "rules/b.rules"]);
  });

  it("from a subdirectory, paths are relative to the repository", async () => {
    const app = join(repo, "apps", "web");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "firebase.json"), JSON.stringify({ remoteconfig: { template: "rc.json" } }));
    expect(await firebaseDeployPaths(app, repo, ["remoteconfig"])).toEqual(["apps/web/firebase.json", "apps/web/rc.json"]);
  });
});

describe("firebase deploy --only: the whole tree whenever the upload cannot be named", () => {
  const wholeTree = async (command: string) => {
    const [part] = (await computeChangeSet([deployOp(command)])).parts;
    expect(part.baseLabel).not.toContain("limited to");
    expect(part.files.map((f) => f.path)).toEqual(expect.arrayContaining(["package-lock.json", "src/app.ts"]));
  };

  it("a hosting or functions target uploads a directory", async () => {
    await wholeTree("firebase deploy --only hosting");
    await wholeTree("firebase deploy --only remoteconfig,functions");
  });

  it("a target it does not know, or one with no file in firebase.json", async () => {
    await wholeTree("firebase deploy --only extensions");
    write("firebase.json", JSON.stringify({ hosting: { public: "dist" } }));
    git("commit", "-q", "-am", "no remoteconfig");
    await wholeTree("firebase deploy --only remoteconfig");
  });

  it("no readable firebase.json in the directory it runs in", async () => {
    write("firebase.json", "{ not json");
    await wholeTree("firebase deploy --only remoteconfig");
  });

  it("a template git ignores, which no diff would show", async () => {
    write(".gitignore", "remoteconfig.template.json\n");
    git("rm", "-q", "--cached", "remoteconfig.template.json");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "ignore template");
    await wholeTree("firebase deploy --only remoteconfig");
  });

  it("a template outside the repository", async () => {
    write("firebase.json", JSON.stringify({ remoteconfig: { template: "../elsewhere.json" } }));
    expect(await firebaseDeployPaths(repo, repo, ["remoteconfig"])).toBeNull();
  });
});
