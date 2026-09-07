/**
 * Round-trip pin for the slash-command expansion format and its inverse.
 *
 * `userAuthoredRequest` recovers what the user typed from the message
 * `expandSlashCommand` builds. The two formatters and the parser share literal
 * strings (see the "MUST move together" comment in slash-commands.ts); this
 * suite is what turns a drift between them into a red test instead of a gate
 * silently judging the SKILL.md template as if the user wrote it
 * (canonical-loop/middlewares/host.ts).
 *
 * Coverage is enumerated from the bundled directory on disk, not a hand list,
 * so a new bundled protocol is covered the moment it lands.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { bundledProtocolsDir } from "./protocols/loader.js";
import {
  expandSlashCommand,
  isSlashCommandExpansion,
  userAuthoredRequest,
} from "./slash-commands.js";

const BUNDLED = readdirSync(bundledProtocolsDir(), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

/** Typed protocols have no SKILL.md; their expansion is the second format. */
const TYPED = ["git_workflow"];

/** Argument shapes the parser must survive. Keys name the hazard. */
const ARGS: Record<string, string> = {
  "one line": "fix the login bug",
  "multi-line": "fix the login bug\nit 500s on submit\nrepro: log in with a stale cookie",
  "multi-paragraph": "fix the login bug.\n\nIt 500s on submit.\n\nRepro: log in with a stale cookie.",
  // The closing section repeats the argument, and the body format wraps the
  // methodology in `---` fences and `## ` headings. An argument carrying the
  // same characters must still parse at the FIRST arg line, unclipped.
  "contains --- and ## headings":
    "Refactor per this plan:\n\n## Scope\n\n- auth\n- session\n\n---\n\n## Out of scope\n\neverything else",
};

describe("bundled protocol directory", () => {
  it("is enumerated from disk and includes the five shipped templates", () => {
    for (const name of ["app-build", "brownfield", "refactor-godfiles", "senior-engineer", "vibe-code"]) {
      expect(BUNDLED).toContain(name);
    }
  });
});

describe("userAuthoredRequest round-trips expandSlashCommand", () => {
  for (const name of [...BUNDLED, ...TYPED]) {
    describe(`/${name}`, () => {
      for (const [label, arg] of Object.entries(ARGS)) {
        it(`with a ${label} argument`, () => {
          const typed = `/${name} ${arg}`;
          const exp = expandSlashCommand(typed);
          expect(exp, `expandSlashCommand must resolve /${name}`).not.toBeNull();
          expect(isSlashCommandExpansion(exp!.agentMessage)).toBe(true);
          expect(userAuthoredRequest(exp!.agentMessage)).toBe(typed);
        });
      }

      it("bare invocation recovers `/name`", () => {
        const exp = expandSlashCommand(`/${name}`);
        expect(exp).not.toBeNull();
        expect(userAuthoredRequest(exp!.agentMessage)).toBe(`/${name}`);
      });

      it("normalizes the way expandSlashCommand does: lowercase command, trimmed argument", () => {
        const shouted = `/${name.toUpperCase()}   fix the login bug  \n`;
        const exp = expandSlashCommand(shouted);
        expect(exp).not.toBeNull();
        expect(userAuthoredRequest(exp!.agentMessage)).toBe(`/${name} fix the login bug`);
      });
    });
  }

  it("recovers the argument and drops the template words the gates key on", () => {
    // The senior-engineer body says "every", "refactor", "delete", "design"…
    // none of that is the user's request.
    const exp = expandSlashCommand("/senior-engineer fix the login bug")!;
    const recovered = userAuthoredRequest(exp.agentMessage);
    expect(recovered).toBe("/senior-engineer fix the login bug");
    expect(recovered).not.toMatch(/methodology|SLASH COMMAND/);
  });
});

describe("userAuthoredRequest on non-expansions", () => {
  it("passes a plain message through byte-identical", () => {
    const msg = "tidy up the grey bar above the nav on mobile";
    expect(userAuthoredRequest(msg)).toBe(msg);
  });

  it("passes an unknown slash command through unchanged (expandSlashCommand returned null for it)", () => {
    expect(expandSlashCommand("/no-such-command do things")).toBeNull();
    expect(userAuthoredRequest("/no-such-command do things")).toBe("/no-such-command do things");
  });

  it("preserves leading whitespace, empty input, and a message that merely mentions the marker mid-text", () => {
    expect(userAuthoredRequest("  indented")).toBe("  indented");
    expect(userAuthoredRequest("")).toBe("");
    const mention = "the message starts with **SLASH COMMAND** — The user invoked, apparently";
    expect(userAuthoredRequest(mention)).toBe(mention);
  });

  it("returns a marker-bearing message unchanged when it lacks the expansion shape", () => {
    const malformed = "**SLASH COMMAND** — The user invoked something without a backticked command";
    expect(userAuthoredRequest(malformed)).toBe(malformed);
  });
});
