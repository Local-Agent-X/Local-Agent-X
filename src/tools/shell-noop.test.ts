// A shell command that only prints its own words is not run, and the answer
// names the tool it mentions (shell-noop.ts; Grok, 2026-11-27).
import { describe, expect, it } from "vitest";
import { printedOnlyText, printOnlyRefusal } from "./shell-noop.js";

describe("a command that only prints its own words", () => {
  it("is recognized, with its words", () => {
    expect(printedOnlyText('echo "calling start_app_build"')).toBe("calling start_app_build");
    expect(printedOnlyText("echo start")).toBe("start");
    expect(printedOnlyText("echo -n ready")).toBe("ready");
    expect(printedOnlyText("Write-Output 'go'")).toBe("go");
    expect(printedOnlyText("true")).toBe("");
    expect(printedOnlyText("printf done")).toBe("done");
  });

  it("anything that expands, redirects, pipes or chains does real work and is run", () => {
    for (const real of ["echo $PATH", "echo hi > notes.txt", "echo y | npx create-app", "echo a && npm test", "echo `date`",
      "ls spec twins", "node -e \"console.log(1)\"", "echo a; rm x", "printf '%s' \"$HOME\""]) {
      expect(printedOnlyText(real), real).toBeNull();
    }
  });

  it("the refusal names the tool the words mention, and only a real tool", () => {
    const isTool = (n: string) => n === "start_app_build";
    expect(printOnlyRefusal('echo "calling start_app_build"', "calling start_app_build", isTool))
      .toBe("Not run: `echo \"calling start_app_build\"` only prints its own words, so it does nothing. `start_app_build` is a tool: call it by name. Say what you are doing in your reply, not in the shell.");
    expect(printOnlyRefusal("echo stop_looping", "stop_looping", isTool)).toContain("If you meant to call a tool, call it by its name.");
  });
});
