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

describe("plan parser — chunk footprint (**Files:** declarations)", () => {
  it("(a) parses a canonical **Files:** bullet into a repo-relative path array", () => {
    const plan = parsePlanText([
      "# Plan",
      "### Chunk 1 — Data layer",
      "- **Class:** trunk",
      "- **Slice:** Set up the DB schema and migrations.",
      "- **Files:** src/db/schema.ts, `src/db/migrate.ts`",
      "- **Depends on:** —",
      "- **Done when:** Migrations run clean.",
    ].join("\n"));

    expect(plan.chunks[0].footprint).toEqual(["src/db/schema.ts", "src/db/migrate.ts"]);
  });

  it("(a') parses newline sub-bullet **Files:** entries and strips markers/backticks", () => {
    const plan = parsePlanText([
      "# Plan",
      "### Chunk 2 — UI",
      "- **Class:** leaf",
      "- **Slice:** Build the settings page.",
      "- **Files:**",
      "  - `src/ui/settings.tsx`",
      "  - src/ui/settings.css",
      "- **Done when:** Page renders.",
    ].join("\n"));

    expect(plan.chunks[0].footprint).toEqual(["src/ui/settings.tsx", "src/ui/settings.css"]);
  });

  it("(b) defaults footprint to [] when the chunk omits **Files:** (back-compat)", () => {
    const plan = parsePlanText([
      "# Plan",
      "### Chunk 1 — Settings page",
      "- **Class:** leaf",
      "- **Slice:** Build the settings page.",
      "- **Done when:** Page renders.",
    ].join("\n"));

    // Undeclared footprint is [], and the chunk still parses (no throw).
    expect(plan.chunks[0].footprint).toEqual([]);
    expect(plan.chunks[0].slice).toContain("settings page");
  });

  it("(c) still feeds legacy **Files** into the Slice fallback AND populates footprint", () => {
    const plan = parsePlanText([
      "# Legacy plan",
      "### Chunk 4 — Authentication",
      "**Goal**: Supabase auth and roles.",
      "**Files**:",
      "- `app/auth/*`",
      "- `middleware.ts`",
      "**Done-when**:",
      "- Sign-in works",
    ].join("\n"));

    // Fallback preserved: Slice was empty, so legacy Goal/Files feed it.
    expect(plan.chunks[0].slice).toContain("Supabase auth and roles");
    expect(plan.chunks[0].slice).toContain("app/auth/*");
    // AND footprint is captured in addition.
    expect(plan.chunks[0].footprint).toEqual(["app/auth/*", "middleware.ts"]);
  });
});
