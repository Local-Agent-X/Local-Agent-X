import { describe, it, expect } from "vitest";
import { evaluateShellCommand } from "./shell-policy.js";

// Regression for the fd-redirect false-positive: the background-detection regex
// flagged the literal `&` in `2>&1` (and `>&2`, `&>file`) as job control, so a
// verification command piping output through `2>&1` got blocked as "backgrounding
// with &" — starving every coding task of a ubiquitous shell idiom.

const blockedFor = (cmd: string) => {
  const r = evaluateShellCommand(cmd);
  return !r.allowed && /background|use && instead/.test(r.reason ?? "");
};

describe("evaluateShellCommand — & is fd-redirect, not backgrounding", () => {
  it("allows the standard stderr→stdout redirect forms", () => {
    for (const cmd of [
      "npm test -- --silent 2>&1 | tail -20",
      "cd app && npm run typecheck 2>&1",
      "tsc --noEmit >&2",
      "cargo build &>build.log",
      "go test ./... 2>&1 | head",
    ]) {
      expect(blockedFor(cmd), cmd).toBe(false);
    }
  });

  it("still blocks a real backgrounded process", () => {
    for (const cmd of [
      "sleep 10 &",
      "npm run dev &",
      "node server.js & npm test",
    ]) {
      expect(blockedFor(cmd), cmd).toBe(true);
    }
  });

  it("still blocks a real backgrounded process that also redirects (the & is caught, the redirect spared)", () => {
    expect(blockedFor("npm run dev 2>&1 &")).toBe(true);
  });

  it("still blocks ; chaining and still allows &&", () => {
    expect(blockedFor("cd app; npm test")).toBe(true);
    expect(blockedFor("cd app && npm test")).toBe(false);
  });
});
