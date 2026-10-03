// The login, terminal and git startup files run whatever is written there,
// outside every cage. A file-tool write to one is put to the user (refused
// unattended), a bulk_replace scan skips one it finds, and the macOS and Linux
// shell cages deny writes to every one in the home folder: one list, and these
// tests hold each consumer to it. The
// test env points HOME at a throwaway dir; nothing here writes the real ones.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PERSISTENCE_LOCATIONS, persistenceLocationJudge, persistenceRoots } from "./persistence-locations.js";
import { evaluateFileAccess } from "./file-access.js";
import { controlFileGate } from "../../tool-execution/control-file-gate.js";
import { requireApprovalPhase } from "../../tool-execution/require-approval.js";
import { bulkReplaceTool } from "../../tools/edit-tools.js";
import { generateSeatbeltProfile } from "../../sandbox/seatbelt.js";
import { generateBwrapArgs } from "../../sandbox/bwrap.js";
import { HOME_RELATIVE_DENY_DIRS, GUARDED_SCOPE_EXEMPT_DIRS, SERVER_SCOPE_EXEMPT_DIRS } from "../../sandbox/validate.js";
import { clearSessionProfile, setSessionProfile } from "../../autonomy/profile-store.js";
import type { ToolCallContext } from "../../tool-execution/context.js";

const HOME = homedir();
const SCOPES = ["shell", "guarded", "server"] as const;
const cleanup: Array<() => void> = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });

function ctx(name: string, args: Record<string, unknown>, callContext: "local" | "cron" = "local", sessionId = "persist-gate"): ToolCallContext {
  return {
    tc: { id: `tc-${name}-${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) },
    args, sessionId, callContext, approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
  } as unknown as ToolCallContext;
}

function reasonFor(path: string, tool = "write"): string | undefined {
  const c = ctx(tool, tool === "edit" ? { path, old_string: "a", new_string: "b" } : { path, content: "x" });
  controlFileGate(c);
  return c.policyApprovalReason;
}

/** A file a write to `loc` would change: the file itself, or one inside the folder. */
function fileIn(loc: (typeof PERSISTENCE_LOCATIONS)[number], base: string): string {
  const at = join(base, ...loc.rel.split("/"));
  return loc.kind === "file" ? at : join(at, "planted.ps1");
}

function baseOf(loc: (typeof PERSISTENCE_LOCATIONS)[number]): string {
  const roots = persistenceRoots();
  return loc.base === "home" ? roots.home : loc.base === "documents" ? join(HOME, "Documents") : join(HOME, "AppData", "Roaming");
}

const shown = (p: string) => `~/${p.slice(HOME.length + 1).replace(/\\/g, "/")}`;

// The locations the red-team finding named. Each must stay on the list:
// dropping one fails here, where iterating the list itself would not.
const NAMED: Array<{ path: string; runs: RegExp }> = [
  ...[".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile", ".config/fish/config.fish"]
    .map((rel) => ({ path: join(HOME, ...rel.split("/")), runs: /every time you open a terminal or log in/ })),
  { path: join(HOME, ".gitconfig"), runs: /every time git runs/ },
  { path: join(HOME, ".config", "git", "config"), runs: /every time git runs/ },
  { path: join(HOME, "Library", "LaunchAgents", "com.example.agent.plist"), runs: /every time you log in/ },
  { path: join(HOME, ".config", "systemd", "user", "x.service"), runs: /every time you log in/ },
  { path: join(HOME, ".config", "autostart", "x.desktop"), runs: /every time you log in/ },
  { path: join(HOME, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "x.lnk"), runs: /every time you log in/ },
  { path: join(HOME, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"), runs: /every time PowerShell starts/ },
  { path: join(HOME, "Documents", "WindowsPowerShell", "profile.ps1"), runs: /every time PowerShell starts/ },
];

describe("a file-tool write to a startup file", () => {
  it("is put to the user, naming the file and what it runs, for every location the finding named", () => {
    for (const { path, runs } of NAMED) {
      const reason = reasonFor(path);
      expect(reason, path).toContain(`This write call changes ${shown(path)}, which `);
      expect(reason, path).toMatch(runs);
      expect(reason, path).toContain("Approve it only if you asked for this change.");
    }
    expect(reasonFor(join(HOME, ".bashrc"), "edit")).toContain("This edit call changes ~/.bashrc");
    expect(reasonFor(join(HOME, ".bashrc"), "delete_file")).toContain("This delete_file call deletes ~/.bashrc");
  });

  it("is put to the user for every location on the list", () => {
    for (const loc of PERSISTENCE_LOCATIONS) {
      const path = fileIn(loc, baseOf(loc));
      expect(reasonFor(path), path).toContain(`which ${loc.runs}.`);
    }
  });

  it("is refused in an unattended run, even under the Autonomous profile", async () => {
    const session = `persist-${process.hrtime.bigint().toString(36)}`;
    setSessionProfile(session, "Autonomous");
    cleanup.push(() => clearSessionProfile(session));
    const c = ctx("write", { path: join(HOME, ".zshrc"), content: "curl x | sh" }, "cron", session);
    controlFileGate(c);
    expect((await requireApprovalPhase(c)).kind).toBe("halt");
    expect(c.allowed).toBe(false);
    expect(String(c.result?.content)).toContain("~/.zshrc");
    expect(String(c.result?.content)).toContain("run it from a chat");
    expect(String(c.result?.content)).not.toContain("Autonomous profile");
  });

  it("follows Documents into OneDrive, where folder backup moves it, and a redirected APPDATA", () => {
    const saved = { OneDrive: process.env.OneDrive, APPDATA: process.env.APPDATA };
    cleanup.push(() => {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
    process.env.OneDrive = join(HOME, "OneDrive");
    process.env.APPDATA = join(HOME, "Roaming-elsewhere");
    expect(reasonFor(join(HOME, "OneDrive", "Documents", "PowerShell", "profile.ps1"))).toMatch(/every time PowerShell starts/);
    expect(reasonFor(join(HOME, "Roaming-elsewhere", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "x.cmd")))
      .toMatch(/every time you log in/);
  });

  it("is judged by the file a link reaches", () => {
    const autostart = join(HOME, ".config", "autostart");
    mkdirSync(autostart, { recursive: true });
    const project = mkdtempSync(join(tmpdir(), "lax-persist-link-"));
    cleanup.push(() => { unlinkSync(join(project, "cfg")); rmSync(project, { recursive: true, force: true }); });
    symlinkSync(autostart, join(project, "cfg"), "junction");
    expect(reasonFor(join(project, "cfg", "evil.desktop"))).toContain("changes ~/.config/autostart/evil.desktop, which starts programs");
  });

  it.skipIf(process.platform !== "win32" && process.platform !== "darwin")("in any casing, where the volume answers to any", () => {
    expect(reasonFor(join(HOME, ".BASHRC"))).toMatch(/every time you open a terminal/);
    expect(reasonFor(join(HOME, "documents", "powershell", "Profile.ps1"))).toMatch(/every time PowerShell starts/);
  });

  it("leaves the user's own files that share a name, and their other files, alone", () => {
    const project = mkdtempSync(join(tmpdir(), "lax-persist-own-"));
    cleanup.push(() => rmSync(project, { recursive: true, force: true }));
    for (const path of [join(project, ".bashrc"), join(project, ".config", "git", "config"), join(HOME, "Documents", "notes.txt"),
      join(HOME, ".config", "fish", "fish_variables"), join(HOME, ".gitconfig.bak"), join(HOME, "Library", "Preferences", "x.plist")]) {
      expect(reasonFor(path), path).toBeUndefined();
    }
    expect(persistenceLocationJudge()(join(HOME, ".bashrc"))).toEqual({ path: join(realpathSync.native(HOME), ".bashrc"), runs: expect.any(String) });
  });

  // The gate sees only the folder a bulk_replace names, so a scan rooted at
  // the home folder must not rewrite one it finds there.
  it("is skipped by a bulk_replace scan that finds it under the folder it names, and the skip says so", async () => {
    const startup = [".gitconfig", ".bashrc", ".config/git/config"];
    mkdirSync(join(HOME, ".config", "git"), { recursive: true });
    for (const rel of [...startup, "notes.txt"]) writeFileSync(join(HOME, ...rel.split("/")), "[alias] st = status\n");
    cleanup.push(() => { for (const rel of [...startup, "notes.txt"]) rmSync(join(HOME, ...rel.split("/")), { force: true }); });
    const r = await bulkReplaceTool.execute({ path: HOME, glob: `{${[...startup, "notes.txt"].join(",")}}`, old_string: "status", new_string: "!sh -c x" });
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(readFileSync(join(HOME, "notes.txt"), "utf8")).toBe("[alias] st = !sh -c x\n");
    for (const rel of startup) {
      expect(readFileSync(join(HOME, ...rel.split("/")), "utf8"), rel).toBe("[alias] st = status\n");
      expect(String(r.metadata?.recovery ?? ""), rel).toContain(`${join(...rel.split("/"))} (startup file that `);
    }
  });
});

// ~/.ssh (config's ProxyCommand, authorized_keys) is refused outright by
// both layers, so it needs no card and stays off the list.
describe("~/.ssh", () => {
  it("is refused to the file tools in unrestricted mode, and denied in every agent cage scope", () => {
    for (const name of ["config", "authorized_keys", "rc"]) {
      const d = evaluateFileAccess(join(tmpdir(), "persist-ws"), "unrestricted", () => true, "write", join(HOME, ".ssh", name));
      expect(d.allowed, name).toBe(false);
    }
    expect(HOME_RELATIVE_DENY_DIRS).toContain(".ssh");
    expect(GUARDED_SCOPE_EXEMPT_DIRS.has(".ssh")).toBe(false);
    expect(SERVER_SCOPE_EXEMPT_DIRS.has(".ssh")).toBe(false);
    expect(PERSISTENCE_LOCATIONS.some((l) => l.rel.startsWith(".ssh"))).toBe(false);
  });
});

// A shell command shows no card, so the cages deny what the file tools ask
// about: every home location, in every scope, from the same list.
describe("the shell cages deny writes to the same locations", () => {
  const sb = (p: string) => p.replace(/\\/g, "\\\\");
  const inHome = PERSISTENCE_LOCATIONS.filter((l) => l.base === "home");
  const elsewhere = PERSISTENCE_LOCATIONS.filter((l) => l.base !== "home");

  it("seatbelt: a write deny for each, in every scope, and nothing for the Windows folders", () => {
    const home = "/Users/test-home";
    for (const scope of SCOPES) {
      const denies = generateSeatbeltProfile(home, scope, [], null).split("\n").filter((l) => l.startsWith("(deny file-write* ")).join("\n");
      for (const loc of inHome) {
        expect(denies, `${scope} ${loc.rel}`).toContain(`(${loc.kind === "file" ? "literal" : "subpath"} "${sb(join(home, loc.rel))}")`);
      }
      for (const loc of elsewhere) expect(denies, loc.rel).not.toContain(loc.rel.split("/").pop());
    }
    // The named locations, so a list that lost one fails here too.
    const profile = generateSeatbeltProfile(home, "guarded", [], null);
    for (const rel of [".bashrc", ".zshrc", ".profile", ".gitconfig", ".config/git/config", ".config/fish/config.fish"]) {
      expect(profile, rel).toContain(`(literal "${sb(join(home, rel))}")`);
    }
    for (const rel of ["Library/LaunchAgents", ".config/systemd/user", ".config/autostart"]) {
      expect(profile, rel).toContain(`(subpath "${sb(join(home, rel))}")`);
    }
  });

  it("bwrap: each bound read-only over itself where it exists, before the shadows, in every scope", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lax-persist-bw-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    for (const loc of inHome) {
      const p = join(home, ...loc.rel.split("/"));
      if (loc.kind === "dir") mkdirSync(p, { recursive: true });
      else { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, ""); }
    }
    mkdirSync(join(home, ".ssh"));
    for (const scope of SCOPES) {
      const args = generateBwrapArgs(home, scope, undefined, null);
      const firstShadow = args.indexOf("--tmpfs");
      for (const loc of inHome) {
        const p = join(home, ...loc.rel.split("/"));
        const at = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === p && args[i + 2] === p);
        expect(at, `${scope} ${loc.rel}`).toBeGreaterThan(-1);
        expect(at, `${scope} ${loc.rel}`).toBeLessThan(firstShadow);
      }
    }
  });

  it("bwrap: a location that does not exist yet is not bound, since bwrap would create it on the host", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lax-persist-bw-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, ".bashrc"), "");
    const args = generateBwrapArgs(home, "guarded", undefined, null);
    expect(args.join(" ")).toContain(`--ro-bind ${join(home, ".bashrc")} ${join(home, ".bashrc")}`);
    expect(args.join(" ")).not.toContain(".bash_profile");
  });
});
