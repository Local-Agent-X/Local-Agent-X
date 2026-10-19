// The installer provisions the Windows cage before the app ever boots, so the
// fence's loopback permit must name the range the app will bind its egress
// proxy in. The step asks the built server's port owner for that range and
// passes it to the one provisioning script; it never falls back to a range of
// its own.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runWindowsCageStep } from "../scripts/installer/windows-cage-step.mjs";

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

// An install root with a staged helper and a stand-in for the built port owner.
function installRoot(portOwner: string): string {
  const root = mkdtempSync(join(tmpdir(), "lax-install-cage-"));
  directories.push(root);
  mkdirSync(join(root, "vendor", "srt-win"), { recursive: true });
  writeFileSync(join(root, "vendor", "srt-win", "srt-win.exe"), "");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(root, "dist", "net"), { recursive: true });
  writeFileSync(join(root, "dist", "net", "shell-proxy-ports.js"), portOwner);
  return root;
}

function run(root: string) {
  const warnings: string[] = [];
  const provisions: string[][] = [];
  const chooserEnv: Array<NodeJS.ProcessEnv | undefined> = [];
  const context = {
    platform: "win32",
    env: { PATH: process.env.PATH },
    installRoot: root,
    dataDirectory: join(root, "data"),
    reporter: { step: () => true, stepDone: () => {}, log: () => {}, ok: () => {}, warn: (m: string) => warnings.push(m) },
    processes: {
      spawnSync: (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        if (cmd === "powershell") { provisions.push(args); return { status: 0, stdout: "", stderr: "" }; }
        chooserEnv.push(opts.env);
        return spawnSync(cmd, args, opts as Parameters<typeof spawnSync>[2]);
      },
    },
  };
  return { context, warnings, provisions, chooserEnv };
}

describe("installer windows cage step: the loopback permit", () => {
  it("provisions the range the app's port owner chose, choosing it against the install's data dir", async () => {
    const root = installRoot(
      "console.log('a log line first');\n" +
      "export async function shellProxyPortRange() { return { from: Number(process.env.LAX_DATA_DIR ? 47090 : 1), to: 47099 }; }\n",
    );
    const { context, warnings, provisions, chooserEnv } = run(root);
    await runWindowsCageStep(context);
    expect(warnings).toEqual([]);
    expect(chooserEnv[0]?.LAX_DATA_DIR).toBe(join(root, "data"));
    expect(provisions).toHaveLength(1);
    const args = provisions[0];
    expect(args[args.indexOf("-PortRange") + 1]).toBe("47090-47099");
  });

  it("no free range installs nothing and says why", async () => {
    const root = installRoot(
      "export async function shellProxyPortRange() { throw new Error('No loopback port range is free for the shell egress proxy: 60090-60099 overlaps the range Windows reserved (60063-60162)'); }\n",
    );
    const { context, warnings, provisions } = run(root);
    await runWindowsCageStep(context);
    expect(provisions).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not installed: No loopback port range is free.*60063-60162/);
  });
});
