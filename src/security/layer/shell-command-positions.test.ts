// The one walk every argv-level shell rule and the publish recogniser read.
// Redirections are the shell's, not the command's: on 2026-09-28 a live
// `git push origin main 2>&1` reached the pre-publish dry run as
// `git push origin main 2>` (the `&1` had become a background command "1"),
// git answered "src refspec 2> does not match any", the review was UNKNOWN,
// and the push went out unreviewed.
import { describe, it, expect } from "vitest";
import { commandPositions } from "./shell-command-positions.js";
import { shellSegments } from "./shell-lex.js";

const words = (command: string) => commandPositions(command).positions.map((p) => p.words);

describe("shellSegments — an & inside a redirection is not a background operator", () => {
  it("keeps `2>&1`, `<&0` and `&>log` in their command", () => {
    expect(shellSegments("git push origin main 2>&1").map((s) => s.text)).toEqual(["git push origin main 2>&1"]);
    expect(shellSegments("cat <&0 && ls").map((s) => s.text)).toEqual(["cat <&0 ", " ls"]);
    expect(shellSegments("make &>build.log").map((s) => s.text)).toEqual(["make &>build.log"]);
  });

  it("still splits a real background operator and `&&`", () => {
    expect(shellSegments("sleep 5 & echo done").map((s) => s.text)).toEqual(["sleep 5 ", " echo done"]);
    expect(shellSegments("a && b").map((s) => s.after)).toEqual([null, "&&"]);
  });
});

describe("commandPositions — redirections are not arguments", () => {
  it("drops the operator and an attached target", () => {
    expect(words("git push origin main 2>&1")).toEqual([["git", "push", "origin", "main"]]);
    expect(words("git push 2>/dev/null origin main")).toEqual([["git", "push", "origin", "main"]]);
    expect(words("npm test >out.log 2>&1")).toEqual([["npm", "test"]]);
    expect(words("vercel --prod &>>deploy.log")).toEqual([["vercel", "--prod"]]);
  });

  it("drops the operator and a separate target word", () => {
    expect(words("git push origin main > push.log 2> err.log")).toEqual([["git", "push", "origin", "main"]]);
    expect(words("sort < names.txt")).toEqual([["sort"]]);
    expect(words("cat <<EOF")).toEqual([["cat"]]);
    expect(words("cat << EOF")).toEqual([["cat"]]);
  });

  it("leaves arguments that merely contain the characters", () => {
    expect(words("dd if=disk.img of=/dev/sdb")).toEqual([["dd", "if=disk.img", "of=/dev/sdb"]]);
    expect(words("grep -e '->' src")).toEqual([["grep", "-e", "->", "src"]]);
    expect(words("git commit -m 'a > b'")).toEqual([["git", "commit", "-m", "a > b"]]);
  });

  it("keeps the redirections on the position for the consumers that read them", () => {
    const [p] = commandPositions("sort < names.txt 2>&1 >> out.log").positions;
    expect(p.redirections).toEqual([
      { op: "<", target: "names.txt" },
      { op: ">&", target: "1" },
      { op: ">>", target: "out.log" },
    ]);
    expect(commandPositions("cat <<EOF").positions[0].redirections).toEqual([{ op: "<<", target: "EOF" }]);
  });

  it("a redirection inside a nested shell body is dropped there, not at the top", () => {
    expect(words("bash -c 'git push origin main 2>&1'")).toEqual([
      ["bash", "-c", "git push origin main 2>&1"],
      ["git", "push", "origin", "main"],
    ]);
  });
});
