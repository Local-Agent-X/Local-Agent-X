/**
 * CLASS INVARIANT: every location the server keeps in its data dir is
 * classified — the agent's working data (no card), put to the user, or a
 * security switch the file tools never write.
 *
 * The instance (2026-10-02): the approval-gated list named seven files while
 * the server trusts well over a hundred there, so the agent could flip the
 * global autonomy profile, self-approve an unconfined shell, or rewrite the
 * agents it delegates to with one write and no card. The default is now the
 * card; this test scans the source rather than trusting a list, so a new data
 * file fails here until someone decides what an agent write to it means.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LAX_DATA_CATALOG, laxDataEntry } from "./lax-data-catalog.js";
import { isLaxControlFile, laxApprovalGatedFile } from "./lax-control-files.js";
import { evaluateFileAccess } from "./file-access.js";
import { TOOL_PATH_ARGS } from "../../tool-registry.js";
import { isAppAtRestSecretBasename } from "../secrets/known-secrets.js";
import { BRAIN_BINARY_FILES, BRAIN_DIRS, BRAIN_JSON_FILES } from "../../sync/constants.js";
import { getMessagingChannelDefinition } from "../../session/channel-registry.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test-helper.ts")) continue;
    out.push(full);
  }
  return out;
}

// What a path is joined onto when it means the data dir: the resolver, the
// names the codebase gives its result, and an inline `<home>, ".lax"`.
const DATA_DIR_BASES = [
  String.raw`getLaxDir\(\)`,
  String.raw`(?:this\.)?(?:LAX_DIR|laxDir|dataDir)`,
  String.raw`\w+\s*\|\|\s*join\(homedir\(\),\s*"\.lax"\)`,
  String.raw`[\w.]+(?:\(\))?\s*,\s*"\.lax"`,
];

const storageFiles = (files: string[]) => files.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/storageFile:\s*"([^"]+)"/g)].map((m) => m[1]!));
const channels = (["telegram", "whatsapp"] as const).map(getMessagingChannelDefinition);

/**
 * Joins whose name the scan cannot read off the line, and the names each
 * reaches. A new one fails until it is entered; a stale one fails too.
 */
function dynamicJoins(files: string[]): Record<string, readonly string[]> {
  return {
    "app-runtime/audit-signing.ts: AUDIT_SEED_BASENAMES[0]": ["audit-key"],
    "app-runtime/audit-signing.ts: AUDIT_SEED_BASENAMES[1]": ["audit-key.enc"],
    "keychain.ts: KEYCHAIN_AT_REST_BASENAMES[0]": ["secrets.salt"],
    "keychain.ts: KEYCHAIN_AT_REST_BASENAMES[1]": ["master.dpapi"],
    "keychain.ts: KEYCHAIN_AT_REST_BASENAMES[2]": ["secrets.enc"],
    "secrets-crypto.ts: name": ["secrets.enc", "audit-key.enc", "auth.json", "anthropic-auth.json", "xai-auth.json"],
    "self-edit/sandbox-gates.ts: tokenFile": ["anthropic-auth.json", "xai-auth.json", "auth.json"],
    "session/channel-registry.ts: definitions[id].configFile": channels.map((c) => c.configFile),
    "session/channel-registry.ts: directory": channels.flatMap((c) => c.authDirectory ?? []),
    "session/channel-registry.ts: definition.authDirectory": channels.flatMap((c) => c.authDirectory ?? []),
    "sync/pull-files/pull-brain.ts: file": [...BRAIN_JSON_FILES, ...BRAIN_BINARY_FILES],
    "sync/pull-files/pull-brain.ts: dir": BRAIN_DIRS,
    "sync/pull-files/pull-brain.ts: sidecar": BRAIN_BINARY_FILES.flatMap((f) => [`${f}-wal`, `${f}-shm`]),
    "sync/push-files.ts: file": [...BRAIN_JSON_FILES, ...BRAIN_BINARY_FILES],
    "sync/push-files.ts: dir": BRAIN_DIRS,
    "orchestrator/system-health.ts: file": [...storageFiles(files), "orchestrator-state.json"],
    "update-recovery.ts: rel": ["update-rollback", "updates"],
    // A PATH directory in a loop that shadows the data-dir name, not the data dir.
    "mcp-client/integrity.ts: command + ext": [],
  };
}

function scan(): { names: Map<string, Set<string>>; dynamic: Set<string> } {
  const files = sourceFiles(SRC);
  const dynamicNames = dynamicJoins(files);
  const names = new Map<string, Set<string>>();
  const dynamic = new Set<string>();
  const add = (name: string, where: string) => {
    const first = name.split("/")[0]!;
    (names.get(first) ?? names.set(first, new Set()).get(first)!).add(where);
  };
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const where = relative(SRC, file).split(sep).join("/");
    const aliases = [...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*getLaxDir\(\)/g)].map((m) => `\\b${m[1]}\\b`);
    const literals = new Map([...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*"([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    const joinedOnto = new RegExp(String.raw`\b(?:join|resolve)\(\s*(?:${[...DATA_DIR_BASES, ...aliases].join("|")})\s*,\s*([^,)]+)`, "g");
    for (const m of source.matchAll(joinedOnto)) {
      const arg = m[1]!.trim();
      const quoted = /^["'`]([^"'`$]+)["'`]$/.exec(arg)?.[1];
      const name = quoted ?? (/^\w+$/.test(arg) ? literals.get(arg) : undefined);
      if (name !== undefined) { add(name, where); continue; }
      const key = `${where}: ${arg}`;
      dynamic.add(key);
      for (const n of dynamicNames[key] ?? []) add(n, where);
    }
  }
  return { names, dynamic };
}

const topLevel = (e: { rel: readonly string[] }) => e.rel[0]!;

describe("every data-dir location the server reads is classified", () => {
  const { names, dynamic } = scan();

  it("finds the data dir's readers (the scan itself works)", () => {
    for (const known of ["settings.json", "hooks.json", "autonomy-profile.json", "sandbox-host-acknowledgement.json", "agent-templates.json", "uploads", "sync-repo"]) {
      expect(names.has(known), known).toBe(true);
    }
    expect(names.size).toBeGreaterThan(120);
  });

  it("each name is in the catalog, or is an at-rest secret the file-access gate refuses outright", () => {
    const unclassified = [...names.keys()].filter((n) => !isAppAtRestSecretBasename(n) && !LAX_DATA_CATALOG.some((e) => e.rel.length === 1 && e.rel[0] === n));
    expect(
      unclassified.map((n) => `${n} (${[...names.get(n)!].join(", ")})`),
      "classify each in security/layer/lax-data-catalog.ts: \"data\" only if the app never acts on what is written there",
    ).toEqual([]);
  });

  it("every join the scan cannot read is accounted for, and no entry is stale", () => {
    const known = Object.keys(dynamicJoins(sourceFiles(SRC)));
    expect([...dynamic].filter((k) => !known.includes(k)), "enter the names these reach in dynamicJoins").toEqual([]);
    expect(known.filter((k) => !dynamic.has(k)), "no longer in the source").toEqual([]);
  });

  it("every catalog entry is still something the server reads", () => {
    const stale = [...new Set(LAX_DATA_CATALOG.map(topLevel))].filter((n) => !names.has(n));
    expect(stale, "remove these from lax-data-catalog.ts").toEqual([]);
  });

  it("no location is entered twice", () => {
    const keys = LAX_DATA_CATALOG.map((e) => e.rel.join("/"));
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

describe("the classes", () => {
  const lax = join(tmpdir(), "catalog-home", ".lax");

  // Widening this list is a security decision: each is a place the agent may
  // write with no card, so the app must never act on what is written there.
  it("the agent's working data is exactly the reviewed allowlist", () => {
    expect(LAX_DATA_CATALOG.filter((e) => e.kind === "data").map((e) => e.rel.join("/")).sort()).toEqual(
      ["audio-cues", "image-cache", "logs", "recordings", "sidecars", "uploads", "voice-tmp", "workspace"],
    );
    for (const e of LAX_DATA_CATALOG) expect(e.note.length, e.rel.join("/")).toBeGreaterThan(15);
  });

  it("sync-repo is not working data: the next sync merges it into this computer", () => {
    expect(laxDataEntry(["sync-repo", "agent-templates.json"])?.kind).toBe("card");
    expect(laxApprovalGatedFile(join(lax, "sync-repo", "cron", "jobs.json"))?.controls).toMatch(/next sync merges/);
  });

  it("the programs under the workspace folder are not working data", () => {
    expect(laxDataEntry(["workspace", "voice-chat", "piper", "piper", "piper.exe"])?.kind).toBe("card");
    expect(laxDataEntry(["workspace", "my-app", "index.html"])?.kind).toBe("data");
  });
});

// Each switches part of the leash, so no card can stand in for the user's own
// Settings: refused in every file-access mode, by name, not by iterating the
// table (a dropped entry must fail here).
describe("the security switches", () => {
  const workspace = join(tmpdir(), "catalog-ws");
  const lax = join(tmpdir(), "catalog-home", ".lax");
  // cron/jobs.json holds each mission's own autonomy profile, which its
  // unattended runs act under without asking; sync-config.json's repoUrl is
  // where the sync heartbeat pushes memory and chats over git, outside the
  // egress gate. A card is one click from either.
  const SWITCHES = ["settings.json", "config.json", "tool-policy.json", "security.json", "egress-allowlist.json", "autonomy-profile.json",
    "sandbox-host-acknowledgement.json", "server-sandbox-boot.json", "tokens.json", "threat-trust-ledger.json", "cron/jobs.json", "sync-config.json"];

  // Every action the policy table hands the gate for a call that changes a
  // file, read off the table: the delete went unrefused while a test checked
  // an action name no tool sends. A delete is a flip too: a missing switch
  // reads as its default, and a missing autonomy-profile.json is Power.
  const CHANGES = [...new Set(Object.values(TOOL_PATH_ARGS).flat().map((s) => s.action))].filter((a) => a !== "read");

  it("are refused to write, edit and delete in every mode, including unrestricted, and stay readable", () => {
    expect(CHANGES.sort()).toEqual(["delete_file", "edit", "write"]);
    for (const name of SWITCHES) {
      expect(isLaxControlFile(join(lax, name)), name).toBe(true);
      for (const mode of ["workspace", "common", "unrestricted"] as const) {
        for (const action of CHANGES) {
          const d = evaluateFileAccess(workspace, mode, () => true, action, join(lax, name));
          expect(d.allowed, `${action} ${name} ${mode}`).toBe(false);
          expect(d.reason, `${action} ${name} ${mode}`).toMatch(/user-owned control file/);
        }
      }
      expect(evaluateFileAccess(workspace, "unrestricted", () => true, "read", join(lax, name)).reason ?? "").not.toMatch(/user-owned control file/);
    }
  });

  it("only at their place in the data dir: a project's own config.json, in the workspace or the sync copy, is not one", () => {
    expect(isLaxControlFile(join(lax, "workspace", "my-app", "config.json"))).toBe(false);
    expect(isLaxControlFile(join(lax, "workspace", "my-app", ".lax", "settings.json"))).toBe(false);
    expect(isLaxControlFile(join(lax, "sync-repo", "settings.json"))).toBe(false);
    expect(isLaxControlFile(join(tmpdir(), "project", "settings.json"))).toBe(false);
    expect(isLaxControlFile(join(lax, "sync-repo", "cron", "jobs.json"))).toBe(false);
    expect(isLaxControlFile(join(tmpdir(), "project", "cron", "jobs.json"))).toBe(false);
  });

  it("the rest of the missions folder is still put to the user, not refused", () => {
    for (const rel of [["cron", "settings.json"], ["cron", "reports", "nightly", "report.md"]]) {
      expect(isLaxControlFile(join(lax, ...rel)), rel.join("/")).toBe(false);
      expect(laxApprovalGatedFile(join(lax, ...rel))?.controls, rel.join("/")).toMatch(/decides what the agent runs on its own/);
    }
  });
});
