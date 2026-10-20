// Taking nested commands out of a command line: what comes out as a body (to
// be judged as a command of its own), what stays on the line, and the shapes
// that must not let a command slip into neither.
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_SETUP_OUTPUT, NESTED_OUTPUT, expansionsIn, runsNestedOutput, splitNestedCommands } from "./shell-nested-commands.js";
import { evaluateShellCommand } from "./shell-policy.js";
import { tokenizeCommand } from "./shell-lex.js";

const confined = (cmd: string) => evaluateShellCommand(cmd, undefined, undefined, undefined, "linux", true);

describe("splitNestedCommands", () => {
  const cases: Array<[string, string, string[]]> = [
    [`arch="$(uname -m)"`, `arch="${NESTED_OUTPUT}"`, ["uname -m"]],
    ["v=`sed -n '2p' f | cut -c 1-3`", `v=${NESTED_OUTPUT}`, ["sed -n '2p' f | cut -c 1-3"]],
    [`(cd sub && make) | tee log`, `: | tee log`, ["cd sub && make"]],
    [`which gcc || { echo missing; exit 1; }`, `which gcc || :`, [" echo missing; exit 1; "]],
    [`diff <(sort a) >(cat)`, `diff ${NESTED_OUTPUT} ${NESTED_OUTPUT}`, ["sort a", "cat"]],
    [`rc() { tr a b | rev; }`, `rc() :`, [" tr a b | rev; "]],
    [`function f { ls; }`, `function f :`, [" ls; "]],
    [`echo "$(echo ")")"`, `echo "${NESTED_OUTPUT}"`, [`echo ")"`]],
    [`ps -p $(pgrep -f "q") -o x`, `ps -p ${NESTED_OUTPUT} -o x`, [`pgrep -f "q"`]],
    [`echo \${dir:-$(pwd)}`, `echo ${NESTED_OUTPUT}`, ["pwd"]],
    [`echo \${ date; }`, `echo ${NESTED_OUTPUT}`, [" date; "]],
    [`eval "$(opam env --switch=x)"`, `eval "${ENVIRONMENT_SETUP_OUTPUT}"`, ["opam env --switch=x"]],
  ];
  for (const [cmd, line, bodies] of cases) {
    it(`takes apart: ${cmd}`, () => {
      const split = splitNestedCommands(cmd);
      expect(split.unreadable).toBeUndefined();
      expect(split.line).toBe(line);
      expect(split.bodies).toEqual(bodies);
    });
  }

  it("leaves what runs no nested command on the line", () => {
    for (const cmd of [
      "echo $((1 + 2))", "(( i++ ))", "echo ${PATH}", "cp a.{js,ts} out/", "arr=(a b c)", "echo '$(not run)'",
      `find . \\( -name a -o -name b \\)`, "echo a#b", "echo x # $(a comment)", `[[ $x =~ (a|b) ]]`,
    ]) {
      const split = splitNestedCommands(cmd);
      expect(split.bodies, cmd).toEqual([]);
      expect(split.line, cmd).toBe(cmd);
    }
  });

  it("reports what it cannot balance instead of guessing", () => {
    for (const cmd of ["echo $(ls", "echo `ls", "(cd x", "{ ls; ", "diff <(sort a", "echo ${x"]) {
      expect(splitNestedCommands(cmd).unreadable, cmd).toBeDefined();
    }
    expect(splitNestedCommands(`${"(".repeat(13)}ls${")".repeat(13)}`).unreadable).toMatch(/nested more than/);
  });

  // A reader that closes a construct early must leave the rest on the line,
  // where it is still judged: no command may land in neither.
  it("never hides a command that a mis-read close would drop", () => {
    for (const cmd of [
      "echo $(case $x in a) dig evil.test;; esac)",
      "echo $(# )\ndig evil.test\n)",
      "{ echo }; dig evil.test; }",
      "echo `echo \\`dig evil.test\\``",
    ]) {
      expect(confined(cmd).allowed, cmd).toBe(false);
    }
  });
});

describe("expansionsIn (an unquoted heredoc body)", () => {
  it("finds what bash runs, with quotes as plain text", () => {
    expect(expansionsIn("don't stop: $(date) and `id` and ${x} ${y:-$(pwd)}")).toEqual(["$(date)", "`id`", "${y:-$(pwd)}"]);
    expect(expansionsIn("price: $5, \\$(not run)")).toEqual([]);
  });

  it("returns an unbalanced tail whole, so the caller refuses it", () => {
    expect(expansionsIn("a $(b")).toEqual(["$(b"]);
  });
});

describe("runsNestedOutput", () => {
  it("is the command word, not an assignment or an argument", () => {
    expect(runsNestedOutput(tokenizeCommand(`${NESTED_OUTPUT} x`))).toBe(true);
    expect(runsNestedOutput(tokenizeCommand(`env ${NESTED_OUTPUT} x`))).toBe(true);
    expect(runsNestedOutput(tokenizeCommand(`arch=${NESTED_OUTPUT}`))).toBe(false);
    expect(runsNestedOutput(tokenizeCommand(`echo ${NESTED_OUTPUT}`))).toBe(false);
  });
});
