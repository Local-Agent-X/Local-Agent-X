import { describe, it, expect } from "vitest";
import { officeThemeGuardMiddleware } from "./office-theme-guard.js";
import type { CanonicalLoopContext } from "./types.js";

function ctxFor(userMessage: string, toolCalls: Array<{ tool: string; args: unknown }>): CanonicalLoopContext {
  return { op: { id: "op-otg" }, userMessage, toolCalls } as unknown as CanonicalLoopContext;
}

describe("office-theme-guard", () => {
  it("strips an uninvited theme from an office tool call (string args)", () => {
    const tc = { tool: "presentation", args: JSON.stringify({ action: "from_outline", file_path: "a.pptx", outline: "# X", theme: '{"colors":{"accent":"#C41E3A"}}' }) };
    officeThemeGuardMiddleware.afterModelCall!(ctxFor("make a power point about reckless ben", [tc]));
    expect(JSON.parse(tc.args as string)).not.toHaveProperty("theme");
    expect(JSON.parse(tc.args as string)).toHaveProperty("outline");
  });

  it("strips from object args too", () => {
    const tc = { tool: "document", args: { action: "create", file_path: "a.docx", content: "x", theme: "{}" } };
    officeThemeGuardMiddleware.afterModelCall!(ctxFor("write a report on Q3", [tc]));
    expect(tc.args).not.toHaveProperty("theme");
  });

  it("keeps the theme when the user asked for a look", () => {
    const tc = { tool: "presentation", args: { action: "create", file_path: "a.pptx", slides: "[]", theme: '{"colors":{"accent":"#C41E3A"}}' } };
    officeThemeGuardMiddleware.afterModelCall!(ctxFor("make the deck red and bold", [tc]));
    expect(tc.args).toHaveProperty("theme");
  });

  it("keeps brand-keyword requests", () => {
    const tc = { tool: "pdf", args: { action: "create", file_path: "a.pdf", content: "x", theme: "{}" } };
    officeThemeGuardMiddleware.afterModelCall!(ctxFor("use our brand styling for this one", [tc]));
    expect(tc.args).toHaveProperty("theme");
  });

  it("ignores non-office tools", () => {
    const tc = { tool: "build_app", args: { name: "x", theme: "dark" } };
    officeThemeGuardMiddleware.afterModelCall!(ctxFor("build me an app", [tc]));
    expect(tc.args).toHaveProperty("theme");
  });
});
