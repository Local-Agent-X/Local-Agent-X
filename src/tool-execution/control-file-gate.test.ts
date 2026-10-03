// A write by the agent to a file the app later acts on (hooks, MCP servers and
// their host trust, the plugin registry, the rollback index, and by default
// everything else in the data dir but the agent's working data) is put to the
// user in an attended run and refused in an unattended one. The user's own
// files that share those names, and reads of the real ones, pass untouched.
// The test env points HOME at a throwaway dir, so ~/.lax here is not the
// developer's.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { controlFileGate } from "./control-file-gate.js";
import { requireApprovalPhase } from "./require-approval.js";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { appendTrashJournal } from "../trash-journal.js";
import { getLaxDir } from "../lax-data-dir.js";
import { platformRoot } from "../platform-root.js";
import type { CallContext, ToolCallContext } from "./context.js";
import type { ServerEvent } from "../types.js";

const LAX = join(homedir(), ".lax");
const HOOKS = join(LAX, "hooks.json");
const GATED: Array<{ rel: string; shown: string; effect: RegExp }> = [
  { rel: "hooks.json", shown: "~/.lax/hooks.json", effect: /runs commands on every tool call/ },
  { rel: "mcp.json", shown: "~/.lax/mcp.json", effect: /decides which MCP servers start/ },
  { rel: "mcp-local-trust.json", shown: "~/.lax/mcp-local-trust.json", effect: /run trusted on this computer, outside the sandbox/ },
  { rel: join("plugins", "registry.json"), shown: "~/.lax/plugins/registry.json", effect: /which plugins load into the app/ },
  { rel: join("rollback", "index.jsonl"), shown: "~/.lax/rollback/index.jsonl", effect: /what an undo copies back/ },
  { rel: "trash-journal.jsonl", shown: "~/.lax/trash-journal.jsonl", effect: /where a restore puts deleted files back/ },
  { rel: join("trash", "task", "s-1", ".manifest.json"), shown: "~/.lax/trash/task/s-1/.manifest.json", effect: /where a restore puts the agent's deleted files back/ },
];

const cleanup: Array<() => void> = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });

function ctx(name: string, args: Record<string, unknown>, callContext: CallContext = "local", sessionId = "ctl-gate", onEvent?: (e: ServerEvent) => void): ToolCallContext {
  return {
    tc: { id: `tc-${name}-${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) },
    args, sessionId, callContext, onEvent, approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
}

function reasonFor(name: string, args: Record<string, unknown>): string | undefined {
  const c = ctx(name, args);
  controlFileGate(c);
  return c.policyApprovalReason;
}

/** A session whose profile alone would let a write run with no prompt. */
function autonomousSession(): string {
  const s = `ctl-gate-${process.hrtime.bigint().toString(36)}`;
  setSessionProfile(s, "Autonomous");
  cleanup.push(() => clearSessionProfile(s));
  return s;
}

describe("a write to a file the app acts on", () => {
  it("names the file and what it controls, for every gated file", () => {
    for (const f of GATED) {
      const reason = reasonFor("write", { path: join(LAX, f.rel), content: "{}" });
      expect(reason, f.rel).toContain(`This write call changes ${f.shown}, which `);
      expect(reason, f.rel).toMatch(f.effect);
      expect(reason, f.rel).toContain("Approve it only if you asked for this change.");
    }
    expect(reasonFor("edit", { path: HOOKS, old_string: "a", new_string: "b" })).toContain("This edit call changes ~/.lax/hooks.json");
    expect(reasonFor("write", { path: "~/.lax/hooks.json", content: "{}" })).toContain("changes ~/.lax/hooks.json");
  });

  it("covers every declared write target: a delete, a restore destination, a document output", () => {
    expect(reasonFor("delete_file", { path: HOOKS })).toContain("This delete_file call deletes ~/.lax/hooks.json");
    expect(reasonFor("restore_file", { path: "notes.txt", destination: join(LAX, "mcp.json") })).toContain("changes ~/.lax/mcp.json");
    expect(reasonFor("document", { action: "template", template_path: "t.docx", output_path: join(LAX, "plugins", "registry.json") }))
      .toContain("changes ~/.lax/plugins/registry.json");
    const both = reasonFor("restore_file", { path: HOOKS, destination: join(LAX, "mcp-local-trust.json") });
    expect(both).toContain("~/.lax/hooks.json");
    expect(both).toContain("~/.lax/mcp-local-trust.json");
  });

  it("follows a link into the data dir: the file written is the file the app reads", () => {
    const project = mkdtempSync(join(tmpdir(), "lax-ctl-link-"));
    cleanup.push(() => rmSync(project, { recursive: true, force: true }));
    symlinkSync(LAX, join(project, "cfg"), "junction");
    expect(reasonFor("write", { path: join(project, "cfg", "hooks.json"), content: "{}" })).toContain("changes ~/.lax/hooks.json");
  });
});

// Windows writes the real file through each of these spellings (Node passes
// them through unchanged), so each must name the file it reaches.
describe.skipIf(process.platform !== "win32")("other Windows spellings of the same file", () => {
  it("an NTFS stream suffix on the file or the folder, including a file that does not exist yet", () => {
    expect(reasonFor("write", { path: `${HOOKS}::$DATA`, content: "{}" })).toContain("changes ~/.lax/hooks.json");
    expect(reasonFor("write", { path: join(`${LAX}::$INDEX_ALLOCATION`, "hooks.json"), content: "{}" })).toContain("changes ~/.lax/hooks.json");
    expect(reasonFor("write", { path: join(`${LAX}:$I30:$INDEX_ALLOCATION`, "plugins", "registry.json"), content: "{}" }))
      .toContain("changes ~/.lax/plugins/registry.json");
    expect(existsSync(join(LAX, "mcp.json"))).toBe(false);
    expect(reasonFor("write", { path: `${join(LAX, "mcp.json")}::$DATA`, content: "{}" })).toContain("changes ~/.lax/mcp.json");
    expect(reasonFor("delete_file", { path: `${HOOKS}::$DATA` })).toContain("deletes ~/.lax/hooks.json");
  });

  it("an 8.3 short name for the data dir or the file, where the volume keeps them", (t) => {
    const shortDir = join(homedir(), "LAX~1");
    writeFileSync(HOOKS, "{}");
    cleanup.push(() => rmSync(HOOKS, { force: true }));
    const shortFile = join(LAX, "HOOKS~1.JSO");
    const sameAs = (a: string, b: string) => existsSync(a) && realpathSync.native(a) === realpathSync.native(b);
    if (!sameAs(shortDir, LAX) || !sameAs(shortFile, HOOKS)) return t.skip();
    expect(reasonFor("write", { path: join(shortDir, "hooks.json"), content: "{}" })).toContain("changes ~/.lax/hooks.json");
    expect(reasonFor("write", { path: join(shortDir, "mcp-local-trust.json"), content: "{}" })).toContain("changes ~/.lax/mcp-local-trust.json");
    expect(reasonFor("edit", { path: shortFile, old_string: "{", new_string: "[" })).toContain("changes ~/.lax/hooks.json");
    expect(reasonFor("delete_file", { path: shortFile })).toContain("deletes ~/.lax/hooks.json");
  });
});

// restore_file writes the original its journal entry records, and the journal
// matches a ref by basename, so the path the call names is not the file it
// writes. A forged or a genuine entry for a gated file is put to the user.
describe("a restore that lands on a file the app acts on", () => {
  const journal = () => join(getLaxDir(), "trash-journal.jsonl");
  function journalled(original: string): void {
    const payload = mkdtempSync(join(tmpdir(), "lax-ctl-trash-"));
    cleanup.push(() => rmSync(payload, { recursive: true, force: true }));
    writeFileSync(join(payload, "copy"), "{}");
    appendTrashJournal({ original, tier: "lax", dest: join(payload, "copy"), kind: "file" });
    cleanup.push(() => rmSync(journal(), { force: true }));
  }

  it("names the journalled file, whatever directory the ref names, and a bare name", () => {
    journalled(HOOKS);
    const elsewhere = mkdtempSync(join(tmpdir(), "lax-ctl-ref-"));
    cleanup.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    for (const path of [join(elsewhere, "hooks.json"), "hooks.json"]) {
      expect(reasonFor("restore_file", { path }), path)
        .toContain("This restore_file call changes ~/.lax/hooks.json, which runs commands on every tool call.");
    }
  });

  it("is refused in an unattended run", async () => {
    journalled(HOOKS);
    const c = ctx("restore_file", { path: "hooks.json" }, "cron", autonomousSession());
    controlFileGate(c);
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(String(c.result?.content)).toContain("~/.lax/hooks.json");
  });

  it("leaves a restore of the user's own file alone", () => {
    const project = mkdtempSync(join(tmpdir(), "lax-ctl-own-"));
    cleanup.push(() => rmSync(project, { recursive: true, force: true }));
    journalled(join(project, "hooks.json"));
    expect(reasonFor("restore_file", { path: "hooks.json" })).toBeUndefined();
    expect(reasonFor("restore_file", { path: join(project, "hooks.json") })).toBeUndefined();
  });
});

// The app reads back far more of its data dir than any hand-kept list named,
// so the default there is the user's yes, and only the agent's working data
// is written without one (security/layer/lax-data-catalog.ts).
describe("everything else in the data dir", () => {
  it("is put to the user, naming what it controls", () => {
    const cases: Array<[string, string]> = [
      ["agent-templates.json", "defines the agents it hands work to: their instructions, tools and schedules"],
      [join("cron", "settings.json"), "decides what the agent runs on its own, and when"],
      [join("memory", "USER.md"), "is part of what the agent remembers and reads back into your chats"],
      [join("workspace", "voice-chat", "whisper-bin", "whisper-cli"), "holds programs or models the app runs"],
      ["integrations.json", "decides which services the agent calls with your saved keys, and at what addresses"],
      [join("sync-repo", "agent-templates.json"), "is the sync copy that the next sync merges into this computer"],
      [join("chrome-profile", "Default", "Preferences"), "is the in-app browser's own profile: its sign-ins, cookies, history and extensions"],
    ];
    for (const [rel, controls] of cases) {
      expect(reasonFor("write", { path: join(LAX, rel), content: "{}" }), rel)
        .toContain(`This write call changes ~/.lax/${rel.replace(/\\/g, "/")}, which ${controls}. Approve it only if you asked for this change.`);
    }
  });

  it("a location nothing names yet is put to the user too", () => {
    expect(reasonFor("write", { path: join(LAX, "notes.md"), content: "x" }))
      .toContain("changes ~/.lax/notes.md, which Local Agent X keeps for itself and reads back.");
    expect(reasonFor("edit", { path: join(LAX, "next-feature", "state.json"), old_string: "a", new_string: "b" }))
      .toContain("changes ~/.lax/next-feature/state.json, which Local Agent X keeps for itself and reads back.");
  });

  it("the agent's working data is written with no card", () => {
    for (const rel of ["uploads/photo.png", "workspace/my-app/index.html", "voice-tmp/a.wav", "image-cache/x.png",
      "recordings/demo.mp4", "audio-cues/ding.wav", "logs/server.log", "sidecars/voice.log"]) {
      expect(reasonFor("write", { path: join(LAX, ...rel.split("/")), content: "x" }), rel).toBeUndefined();
    }
  });

  it("a link inside the working data is judged by the file it reaches", () => {
    mkdirSync(join(LAX, "uploads"), { recursive: true });
    const link = join(LAX, "uploads", "cfg");
    symlinkSync(LAX, link, "junction");
    cleanup.push(() => unlinkSync(link));
    expect(reasonFor("write", { path: join(link, "hooks.json"), content: "{}" })).toContain("changes ~/.lax/hooks.json, which runs commands");
  });
});

describe("nothing to ask", () => {
  it("a read of a gated file, by any read tool or read action", () => {
    expect(reasonFor("read", { path: HOOKS })).toBeUndefined();
    expect(reasonFor("grep", { path: HOOKS, pattern: "command" })).toBeUndefined();
    expect(reasonFor("document", { action: "read", file_path: join(LAX, "mcp.json") })).toBeUndefined();
  });

  it("the user's own files that share the names, outside the data dir or in the agent's working data inside it", () => {
    const project = mkdtempSync(join(tmpdir(), "lax-ctl-project-"));
    cleanup.push(() => rmSync(project, { recursive: true, force: true }));
    expect(reasonFor("write", { path: join(project, "hooks.json"), content: "{}" })).toBeUndefined();
    expect(reasonFor("write", { path: join(project, "plugins", "registry.json"), content: "{}" })).toBeUndefined();
    expect(reasonFor("write", { path: join(project, "trash", "task", "s-1", ".manifest.json"), content: "[]" })).toBeUndefined();
    expect(reasonFor("write", { path: join(LAX, "workspace", "my-app", "hooks.json"), content: "{}" })).toBeUndefined();
    expect(reasonFor("write", { path: join(LAX, "uploads", "mcp.json"), content: "{}" })).toBeUndefined();
  });

  // The install's config/ is not the user's to approve into: the file-access
  // gate refuses every write there outright (file-access.test.ts), and only
  // self_edit in developer mode changes it, so there is no card to raise.
  it("the install's config/, the protected-files list included", () => {
    for (const name of ["protected-files.json", "system-prompt.md", "tools.json"]) {
      expect(reasonFor("write", { path: join(platformRoot(), "config", name), content: "{}" }), name).toBeUndefined();
    }
  });
});

describe("the approval phase carries the reason out", () => {
  it("an attended run raises one card that names the file, even on a profile that would not ask", async () => {
    const s = autonomousSession();
    const events: ServerEvent[] = [];
    const c = ctx("write", { path: HOOKS, content: "{}" }, "local", s, (e) => {
      events.push(e);
      if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, true);
    });
    controlFileGate(c);
    expect((await requireApprovalPhase(c)).kind).toBe("continue");
    const cards = events.filter((e): e is Extract<ServerEvent, { type: "approval_requested" }> => e.type === "approval_requested");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.context).toContain("This write call changes ~/.lax/hooks.json, which runs commands on every tool call.");

    const plain = ctx("write", { path: join(LAX, "uploads", "notes.md"), content: "x" }, "local", s, (e) => events.push(e));
    controlFileGate(plain);
    expect((await requireApprovalPhase(plain)).kind).toBe("continue");
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
  });

  // No profile lifts this refusal, so the way to get the change made is a
  // chat, never a looser profile.
  it("an unattended run is refused, naming the file, even under the Autonomous profile", async () => {
    for (const callContext of ["cron", "delegated"] as const) {
      const c = ctx("write", { path: join(LAX, "plugins", "registry.json"), content: "{}" }, callContext, autonomousSession());
      controlFileGate(c);
      expect((await requireApprovalPhase(c)).kind, callContext).toBe("halt");
      expect(c.allowed).toBe(false);
      expect(c.result?.status).toBe("blocked");
      expect(String(c.result?.content)).toContain("BLOCKED (unattended)");
      expect(String(c.result?.content)).toContain("~/.lax/plugins/registry.json");
      expect(String(c.result?.content)).toContain("run it from a chat");
      expect(String(c.result?.content)).not.toContain("Autonomous profile");
    }
  });

  it("a refusal only the profile makes still points at the profiles", async () => {
    const s = `ctl-gate-normal-${process.hrtime.bigint().toString(36)}`;
    setSessionProfile(s, "Normal");
    cleanup.push(() => clearSessionProfile(s));
    const c = ctx("http_request", { url: "https://example.com", method: "POST" }, "cron", s);
    controlFileGate(c);
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(String(c.result?.content)).toContain("Run this under the Autonomous profile");
    expect(String(c.result?.content)).not.toContain("run it from a chat");
  });
});
