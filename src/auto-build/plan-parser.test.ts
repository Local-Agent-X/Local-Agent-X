import { describe, expect, it } from "vitest";
import { parsePlanText } from "./plan-parser.js";

describe("plan parser contract completeness", () => {
  it("parses the legacy Goal/Files/Done-when shape without emitting blank worker fields", () => {
    const plan = parsePlanText([
      "# Legacy plan",
      "### Chunk 4 — Authentication",
      "**Goal**: Supabase auth and roles.",
      "**Files**:",
      "- `app/auth/*`",
      "- `middleware.ts`",
      "**Done-when**:",
      "- Sign-in works",
      "- Protected routes enforce roles",
    ].join("\n"));

    expect(plan.chunks[0].slice).toContain("Supabase auth and roles");
    expect(plan.chunks[0].slice).toContain("app/auth/*");
    expect(plan.chunks[0].doneWhen).toContain("Sign-in works");
  });

  it("rejects a chunk before launch when scope or success contract is empty", () => {
    expect(() => parsePlanText([
      "# Broken plan",
      "### Chunk 1 — Empty shell",
      "- **Class:** mixed",
    ].join("\n"))).toThrow(/incomplete chunk contract.*Slice.*Done when/i);
  });
});
