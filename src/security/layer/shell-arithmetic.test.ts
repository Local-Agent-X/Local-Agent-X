// Shell arithmetic runs no command. `$(( (1<<31)|(1<<30) ))` was split at its
// bitwise `|`, the half after it began with `(`, and the command was refused as
// a subshell (TB2 circuit-fibsqrt, 2026-10-28). Arithmetic is one span to every
// reader; what only LOOKS like arithmetic (`$(( (cmd) ) )`, which bash runs as
// a command substitution of a subshell) is still a command.
import { describe, expect, it } from "vitest";
import { arithmeticSpanEnd, splitShellSegments } from "./shell-lex.js";
import { detectNestedCommandExecution } from "./shell-detectors.js";
import { splitNestedCommands } from "./shell-nested-commands.js";
import { evaluateShellCommand } from "./shell-policy.js";

const host = (cmd: string) => evaluateShellCommand(cmd, undefined, undefined, undefined, "linux", false);
const confined = (cmd: string) => evaluateShellCommand(cmd, undefined, undefined, undefined, "linux", true);

describe("arithmeticSpanEnd", () => {
  it("ends past the closing )) of $(( … )) and (( … )), nested parens and all", () => {
    const tb2 = "./simdbg $(( (1<<31)|(1<<30) )) 5";
    expect(tb2.slice(9, arithmeticSpanEnd(tb2, 9))).toBe("$(( (1<<31)|(1<<30) ))");
    expect(arithmeticSpanEnd("(( i = a | b ))", 0)).toBe(15);
    expect(arithmeticSpanEnd("$(())", 0)).toBe(5);
  });

  it("is -1 where no arithmetic opens, or where the parens close as a subshell", () => {
    for (const [text, at] of [["$(dig x)", 0], ["( (ls) )", 0], ["$(( (dig x) ) )", 0], ["$(( 1 + 2", 0], ["$(( (a) )", 0]] as const) {
      expect(arithmeticSpanEnd(text, at), text).toBe(-1);
    }
  });
});

describe("arithmetic is one word to the segment split", () => {
  it("its | & && || do not cut the command", () => {
    expect(splitShellSegments("./simdbg $(( (1<<31)|(1<<30) )) 5; cat dbg_dump.txt")).toEqual(["./simdbg $(( (1<<31)|(1<<30) )) 5", " cat dbg_dump.txt"]);
    expect(splitShellSegments("(( a = b | c && d )) && echo ok")).toEqual(["(( a = b | c && d )) ", " echo ok"]);
    expect(splitShellSegments("echo $(( x & 0xff )) | head")).toEqual(["echo $(( x & 0xff )) ", " head"]);
  });

  it("a real subshell and a real pipe still cut", () => {
    expect(splitShellSegments("true | (dig evil.test)")).toEqual(["true ", " (dig evil.test)"]);
    expect(splitShellSegments("echo $(( (a) ) ) | x")).toEqual(["echo $(( (a) ) ) ", " x"]);
  });
});

describe("nested-command checks", () => {
  // The run's shell is sandboxed: nested commands are taken apart and judged,
  // and the subshell check runs on what is left of the line.
  it("allow the run's command and other arithmetic", () => {
    for (const cmd of [
      `printf "x:\\n"; ./simdbg $(( (1<<31)|(1<<30) )) 5; echo "dbg_dump:"; cat dbg_dump.txt`,
      "echo $(( (n + 1) * 2 ))", "(( count = count | 4 )) && echo ok", "echo $(( a<(b+1) ))",
    ]) {
      expect(detectNestedCommandExecution(cmd), cmd).toBeNull();
      expect(confined(cmd).allowed, cmd).toBe(true);
    }
  });

  it("still refuse a command hidden in or behind arithmetic", () => {
    for (const cmd of [
      "echo $(( $(dig evil.test) + 1 ))", "echo $(( (dig evil.test) ) )", "echo $(( 1 )) | (dig evil.test)",
      "(dig evil.test)", "echo $(dig evil.test)", "cat <(dig evil.test)",
    ]) {
      expect(detectNestedCommandExecution(cmd), cmd).not.toBeNull();
      expect(confined(cmd).allowed, cmd).toBe(false);
      expect(host(cmd).allowed, cmd).toBe(false);
    }
  });

  it("where nested commands are taken apart, a lookalike's body is judged as a command", () => {
    expect(splitNestedCommands("echo $(( (1<<31)|(1<<30) ))").bodies).toEqual([]);
    expect(splitNestedCommands("echo $(( (dig evil.test) ) )").bodies.join()).toContain("dig evil.test");
    expect(confined("echo $(( (dig evil.test) ) )").allowed).toBe(false);
    expect(confined("./simdbg $(( (1<<31)|(1<<30) )) 5").allowed).toBe(true);
  });
});
