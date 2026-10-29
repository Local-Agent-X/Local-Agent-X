/**
 * What runs before a delete may copy, build or run anything, but must not be
 * able to move data onto the delete's target or change which program the
 * delete runs (delete-prefix.ts). Both directions, each on the segment index
 * of the delete.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellDeletes } from "../security/layer/shell-delete-targets.js";
import { shellSegments } from "../security/layer/shell-lex.js";
import { cdCannotFail, deleteLine, errexitStopsFailedCd, priorRunsLeave, runsAlone } from "./delete-prefix.js";

const T = "/tmp/clonetest";
/** The delete is the last segment of each command below. */
const leaves = (command: string, target = T) => {
  const line = deleteLine(command)!;
  const last = shellSegments(line).length - 1;
  return priorRunsLeave(line, last, target);
};

describe("priorRunsLeave: what moves nothing onto the target", () => {
  it.each([
    "set -e; export SSHPASS=password; rm -rf /tmp/clonetest",
    "tar xzf /tmp/cc.tgz -C /tmp; rm -rf /tmp/clonetest",
    "cp -r /home/u/project /tmp/clonetest; rm -rf /tmp/clonetest",
    "git clone git@localhost:/git/project /tmp/clonetest; rm -rf /tmp/clonetest",
    "kill $(cat /tmp/clonetest/qemu.pid); rm -rf /tmp/clonetest",
    "make -j8 > /tmp/build.log; rm -rf /tmp/clonetest",
    "mv /tmp/a.log /var/log/a.log; rm -rf /tmp/clonetest",
    "ln -sf /app/site.conf /etc/nginx/sites-enabled/site; rm -rf /tmp/clonetest",
    "python3 -c 'print(1)'; rm -rf /tmp/clonetest",
    "gzip /var/log/old.log; rm -rf /tmp/clonetest",
  ])("%s", (command) => expect(leaves(command)).toBe(true));
});

describe("priorRunsLeave: what could put data there, or change what the delete runs", () => {
  it.each([
    "mv /home/u/docs /tmp/clonetest; rm -rf /tmp/clonetest",
    "mv /home/u/clonetest /tmp; rm -rf /tmp/clonetest",
    "mv /home/u/docs /tmp/clonetest/docs; rm -rf /tmp/clonetest",
    "mv docs /tmp/elsewhere; rm -rf /tmp/clonetest",
    "mv -t /tmp/clonetest /home/u/docs; rm -rf /tmp/clonetest",
    "ln -s /home/u/docs /tmp/clonetest; rm -rf /tmp/clonetest",
    "mount --bind /home/u/docs /tmp/clonetest; rm -rf /tmp/clonetest",
    "rsync -a --remove-source-files /home/u/docs/ /tmp/clonetest/; rm -rf /tmp/clonetest",
    "tar cf /tmp/clonetest --remove-files /home/u/docs; rm -rf /tmp/clonetest",
    "find /home/u -name docs -exec mv {} /tmp/clonetest \\;; rm -rf /tmp/clonetest",
    "echo /home/u/docs | xargs mv /tmp/clonetest; rm -rf /tmp/clonetest",
    "ls $(mv /home/u/docs /tmp/clonetest); rm -rf /tmp/clonetest",
    "git mv docs /tmp/clonetest; rm -rf /tmp/clonetest",
    "python3 -c \"import shutil; shutil.move('/home/u/docs', '/tmp/clonetest')\"; rm -rf /tmp/clonetest",
    "export PATH=/home/u/bin:$PATH; rm -rf /tmp/clonetest",
    "alias rm='mv -t /home/u/keep'; rm -rf /tmp/clonetest",
    "source ./env.sh; rm -rf /tmp/clonetest",
    "rm() { mv \"$@\" /home/u/keep; }; rm -rf /tmp/clonetest",
    "mv $SRC /tmp/clonetest; rm -rf /tmp/clonetest",
  ])("%s", (command) => expect(leaves(command)).toBe(false));

  it("a compressor renaming the target's file in place", () => {
    expect(leaves("gzip /home/u/thesis.docx; rm -f /home/u/thesis.docx.gz", "/home/u/thesis.docx.gz")).toBe(false);
    expect(leaves("gzip -k /home/u/thesis.docx; rm -f /home/u/thesis.docx.gz", "/home/u/thesis.docx.gz")).toBe(true);
  });
});

describe("deleteLine and runsAlone", () => {
  it.runIf(process.platform !== "win32")("folds a program's heredoc into one word; refuses a shell's", () => {
    expect(deleteLine("python3 - <<'EOF'\nimport os\nEOF\nrm -rf /tmp/x")?.split("\n")).toHaveLength(2);
    expect(deleteLine("bash <<'EOF'\nmv /home/u/docs /tmp/x\nEOF\nrm -rf /tmp/x")).toBeNull();
  });

  it("a pipe or & on either side runs the delete alongside a neighbour", () => {
    expect(runsAlone("a; rm -rf x; b", 1)).toBe(true);
    expect(runsAlone("a | rm -rf x", 1)).toBe(false);
    expect(runsAlone("rm -rf x & b", 0)).toBe(false);
    expect(runsAlone("a & rm -rf x", 1)).toBe(false);
  });
});

describe("cdCannotFail: a cd whose folder exists carries past ; and a newline", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lax-delete-prefix-")); mkdirSync(join(root, "vm")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const posix = (p: string) => p.replace(/\\/g, "/");

  it("places the delete in an existing folder, not in a missing or moved one", () => {
    const vm = posix(join(root, "vm"));
    const placed = (command: string) => shellDeletes(command, posix(root), cdCannotFail(command)).at(-1)?.cwd;
    expect(placed(`cd ${vm}\nrm -f qmp.sock`)).toBe(join(root, "vm"));
    expect(placed(`cd ${vm}/missing\nrm -f qmp.sock`)).toBeNull();
    expect(placed(`mv ${vm} ${posix(root)}/old; cd ${vm}; rm -f qmp.sock`)).toBeNull();
    expect(placed(`rm -rf ${vm}; cd ${vm}; rm -f qmp.sock`)).toBeNull();
    expect(shellDeletes(`cd ${vm}\nrm -f qmp.sock`, posix(root)).at(-1)?.cwd).toBeNull();
  });
});

// Under `set -e` a cd that fails ends the script, so what runs after it runs
// in its folder whether or not the folder exists yet. TB2 configure-git-
// webserver, 2026-10-28: `set -e⏎mkdir -p /tmp/e2e && cd /tmp/e2e⏎rm -rf key*`.
describe("errexitStopsFailedCd: where bash's errexit ends the script at a failed cd", () => {
  const atCd = (command: string) => {
    const line = deleteLine(command)!;
    const at = shellSegments(line).findIndex((s) => /^\s*cd\b/.test(s.text));
    return errexitStopsFailedCd(line, at);
  };

  it.each([
    "set -e\nmkdir -p /tmp/e2e && cd /tmp/e2e\nrm -rf key* testrepo",
    "set -euo pipefail; cd /tmp/new; rm -f a",
    "set -o errexit\ncd /tmp/new\nrm -f a",
    "set -e\n# you'll want a fresh dir\ncd /tmp/new\nrm -f a",
  ])("stops: %s", (command) => expect(atCd(command)).toBe(true));

  it.each([
    "mkdir -p /tmp/e2e && cd /tmp/e2e\nrm -rf key*",
    "set -e; set +e; cd /tmp/new; rm -f a",
    "set -e; cd /tmp/new || true; rm -f a",
    "set -e; cd /tmp/new && ls; rm -f a",
    "set -e; if true; then\ncd /tmp/new\nfi; rm -f a",
    "set -e; (cd /tmp/new; rm -f a)",
    "f() { set -e; }; cd /tmp/new; rm -f a",
    "set -e; while read d; do\ncd /tmp/new\ndone; rm -f a",
  ])("does not: %s", (command) => expect(atCd(command)).toBe(false));
});

describe("cdCannotFail under errexit", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "lax-delete-prefix-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const posix = (p: string) => p.replace(/\\/g, "/");
  const placed = (command: string) => shellDeletes(command, posix(root), cdCannotFail(command)).at(-1)?.cwd;

  it("places the delete in a folder the script makes, and only where a failed cd stops it", () => {
    const fresh = posix(join(root, "e2e"));
    expect(placed(`set -e\nmkdir -p ${fresh} && cd ${fresh}\nrm -rf key* testrepo`)).toBe(join(root, "e2e"));
    expect(placed(`mkdir -p ${fresh} && cd ${fresh}\nrm -rf key* testrepo`)).toBeNull();
    expect(placed(`set -e\nln -sfn /home/user ${fresh}\ncd ${fresh}\nrm -rf key*`)).toBeNull();
  });
});
