// The proofs read a command with a literal `$NAME` spelled out and, under Git
// Bash on Windows, its drive paths in Win32 form. Everything else is left as
// written, so what the proofs refused before they refuse still.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { proofText } from "./shell-proof-text.js";

const read = (command: string) => proofText(command, false);

describe("a name assigned one literal on the line", () => {
  it("is spelled out where it is used after the assignment, quoted or bare", () => {
    expect(read('W="/home/u/apps"; mkdir -p "$W/x" && cd "$W/x" && rm -rf package'))
      .toBe('W="/home/u/apps"; mkdir -p "/home/u/apps/x" && cd "/home/u/apps/x" && rm -rf package');
    expect(read("D=/tmp/build && rm -rf ${D}/out $D")).toBe("D=/tmp/build && rm -rf /tmp/build/out /tmp/build");
    expect(read("export D='/tmp/b'\nrm -rf $D")).toBe("export D='/tmp/b'\nrm -rf /tmp/b");
  });

  it("stays `$NAME` inside single quotes, before the assignment, and for another name", () => {
    expect(read("W=/a; echo '$W'; rm -rf $W")).toBe("W=/a; echo '$W'; rm -rf /a");
    expect(read("rm -rf $W; W=/a")).toBe("rm -rf $W; W=/a");
    expect(read("W=/a; rm -rf $WORK $W2 ${W}x")).toBe("W=/a; rm -rf $WORK $W2 /ax");
  });

  it("a value with whitespace is spelled out only inside double quotes, where it stays one word", () => {
    expect(read('W="/c/Local Agent X/apps"; ls "$W/x"; rm -rf $W/x'))
      .toBe('W="/c/Local Agent X/apps"; ls "/c/Local Agent X/apps/x"; rm -rf $W/x');
  });

  it("is not a literal when it expands, is assigned twice, or sits inside a compound", () => {
    for (const command of [
      "W=$(pwd); rm -rf $W",
      'W="$HOME/x"; rm -rf $W',
      "W=`pwd`; rm -rf $W",
      "W=/a; W=/b; rm -rf $W",
      "W=/a; rm -rf $W; W=/b",
      "if test -d /x; then\nW=/a\nfi\nrm -rf $W",
      "for i in 1 2; do W=/a; done; rm -rf $W",
      "W=/a b; rm -rf $W",
      'W="a\\"b"; rm -rf $W',
    ]) expect(read(command), command).toBe(command);
  });

  it("keeps an escaped dollar, and a line with no use exactly as written", () => {
    expect(read('W=/a; echo "\\$W"; rm -rf $W')).toBe('W=/a; echo "\\$W"; rm -rf /a');
    const plain = 'ls -a "x y"  ;  mkdir -p z && cd z || echo no\nrm -rf p  q &';
    expect(read(plain)).toBe(plain);
  });
});

describe("Git Bash's drive paths on Windows", () => {
  const temp = tmpdir().replace(/\\/g, "/");

  it("read as the Win32 paths they are there, and nowhere else", () => {
    expect(proofText('cd "/c/Users/me/Local Agent X/apps" && rm -rf /d/out /tmp/x /tmp', true))
      .toBe(`cd "C:/Users/me/Local Agent X/apps" && rm -rf D:/out ${temp}/x ${temp}`);
    expect(proofText('cd "/c/Users/me/apps" && rm -rf /tmp/x', false)).toBe('cd "/c/Users/me/apps" && rm -rf /tmp/x');
  });

  it("leave a device, a share, a URL, a /tmpfoo and a path inside a word alone", () => {
    const command = "curl http://h/c/x > /dev/null; ls //srv/share /tmpfoo a/c/b -o/c/x";
    expect(proofText(command, true)).toBe(command);
  });

  it("apply after a literal name is spelled out", () => {
    expect(proofText('W="/c/apps"; cd "$W/x" && rm -rf package', true)).toBe('W="C:/apps"; cd "C:/apps/x" && rm -rf package');
  });
});
