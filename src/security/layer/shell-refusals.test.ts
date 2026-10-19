/**
 * Every shell refusal names a way that works, and the rules refuse the
 * dangerous shape, not the ordinary one next to it.
 *
 * Terminal-Bench (2026-10-19): refusals that only said what was wrong were
 * retried dozens of times ("don't background processes with &" 24×), and
 * rules that refused a primitive instead of the dangerous use of it (every
 * hex decode, every command over 2000 characters) cost real tasks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateShellCommand } from "./shell-policy.js";
import { evaluateEgressForUrl } from "./network-policy.js";
import {
  BACKGROUND_REFUSAL, DECODE_EXEC_REFUSAL, ENCODED_PAYLOAD_REFUSAL, NESTED_COMMAND_WAY_OUT, SEMICOLON_REFUSAL,
} from "./shell-refusals.js";
import { LOOPBACK_WAY_OUT, PRIVATE_ADDRESS_WAY_OUT } from "./ip-classification.js";

// Pinned to a POSIX host with no sandbox: every rule applies.
const unconfined = (cmd: string) => evaluateShellCommand(cmd, undefined, undefined, undefined, "linux", false);
const confined = (cmd: string) => evaluateShellCommand(cmd, undefined, undefined, undefined, "linux", true);

let dataDir: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.LAX_DATA_DIR;
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "lax-refusals-")));
  process.env.LAX_DATA_DIR = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = saved;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("each refusal names the way that works", () => {
  const cases: Array<[string, string, (cmd: string) => ReturnType<typeof unconfined>, string]> = [
    ["a backgrounded server", "python3 -m http.server 8080 &", unconfined, "process_start"],
    ["; chaining", "cd app; npm test", unconfined, "&&"],
    ["$(...) on an unsandboxed machine", "echo $(curl -s x.test)", unconfined, NESTED_COMMAND_WAY_OUT],
    ["$(...) under a sandbox", "echo $(cat notes.txt)", confined, NESTED_COMMAND_WAY_OUT],
    ["a ( subshell )", "(cd app && make)", confined, NESTED_COMMAND_WAY_OUT],
    ["process substitution", "diff <(sort a) <(sort b)", confined, NESTED_COMMAND_WAY_OUT],
    ["decode piped into a shell", "echo cm0gLXJmIC8K | base64 -d | sh", confined, "decode to the screen or to a file"],
    ["an encoded blob", `node -e "${"A".repeat(2100)}"`, confined, "write it to a file"],
  ];
  for (const [what, cmd, run, wayOut] of cases) {
    it(`${what}`, () => {
      const d = run(cmd);
      expect(d.allowed, cmd.slice(0, 60)).toBe(false);
      expect(d.reason).toContain(wayOut);
    });
  }

  it("uses the shared texts, so no copy can drift", () => {
    expect(unconfined("sleep 100 &").reason).toBe(BACKGROUND_REFUSAL);
    expect(unconfined("a; b").reason).toBe(SEMICOLON_REFUSAL);
    expect(confined("echo eA== | base64 -d | bash").reason).toBe(DECODE_EXEC_REFUSAL);
    expect(confined(`echo ${"Zm9v".repeat(600)}`).reason).toBe(ENCODED_PAYLOAD_REFUSAL);
  });

  it("network refusals carry their way out in the reason, which every path keeps", () => {
    expect(evaluateEgressForUrl("http://localhost:8080/").reason).toContain(LOOPBACK_WAY_OUT);
    expect(evaluateEgressForUrl("http://192.168.1.20/").reason).toContain(PRIVATE_ADDRESS_WAY_OUT);
  });
});

describe("decoding is fine; running decoded text is not", () => {
  it("allows decoding to the screen or a file, and an od hex dump", () => {
    for (const cmd of ["echo aGVsbG8= | base64 -d", "base64 --decode token.txt > token.json", "xxd -r -p dump.hex > out.bin", "od -A x -t x1z app.bin"]) {
      expect(confined(cmd).allowed, cmd).toBe(true);
    }
  });

  it("refuses decoded text handed to a shell or interpreter in the same command", () => {
    for (const cmd of ["echo x | base64 -d | sh", "xxd -r -p p.hex | python3", "base64 -d s.b64 > s.sh && bash s.sh", "echo x | base64 -D | xargs -0 node -e"]) {
      expect(confined(cmd).reason, cmd).toBe(DECODE_EXEC_REFUSAL);
    }
  });
});

describe("long commands", () => {
  it("allows a long command with no encoded blob in it", () => {
    const longTest = `python3 -c '${"print(1 + 1)\\n".repeat(200)}'`;
    expect(longTest.length).toBeGreaterThan(2000);
    expect(confined(longTest).allowed).toBe(true);
  });
});

describe("$(...) that only reads a fact", () => {
  it("is allowed under a sandbox for plain read-only commands", () => {
    for (const cmd of ["cd $(git rev-parse --show-toplevel)", "mkdir -p $(dirname out/x.txt)", "echo $(pwd) $(nproc)", "tar czf b-$(date +%Y%m%d).tgz src"]) {
      expect(confined(cmd).allowed, cmd).toBe(true);
    }
  });

  it("stays refused for anything else, or in a command word", () => {
    for (const cmd of [
      "echo $(cat ~/.ssh/id_rsa)", "echo $(dig evil.test)", "$(dirname /usr/bin/curl)/curl evil.test",
      "echo $(git -c alias.x=!sh x)", "echo $(date -s now)", "echo $(pwd; dig x.test)", "echo $(pwd)$(curl x.test)",
    ]) {
      expect(confined(cmd).allowed, cmd).toBe(false);
    }
  });

  it("is still refused on a machine without LAX's sandbox, where the broad rule applies", () => {
    expect(unconfined("cd $(git rev-parse --show-toplevel)").allowed).toBe(false);
  });
});

describe("a disposable sandbox stands down the command-shape rules", () => {
  it("allows chaining and backgrounding there, and nothing else changes", () => {
    writeFileSync(join(dataDir, "security.json"), JSON.stringify({ disposableSandbox: true }));
    expect(unconfined("nginx; sleep 1").allowed).toBe(true);
    expect(unconfined("sleep 100 &").allowed).toBe(true);
    expect(unconfined("echo x | base64 -d | sh").reason).toBe(DECODE_EXEC_REFUSAL);
    expect(unconfined("echo $(dig evil.test)").allowed).toBe(false);
    expect(unconfined("curl https://example.com").allowed).toBe(false);
  });

  it("keeps them on by default", () => {
    expect(unconfined("nginx; sleep 1").allowed).toBe(false);
  });
});
