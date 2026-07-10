import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("provider auth documentation and UI copy", () => {
  it("identifies LAX-owned files as encrypted envelopes", () => {
    const docs = read("docs/provider-auth.md");
    const app = read("public/app.html");

    for (const path of ["auth.json", "anthropic-auth.json", "xai-auth.json"]) {
      expect(docs).toContain(path);
      expect(app).toMatch(new RegExp(`encrypted (?:LAX credential )?envelope[^\\n]*${path.replace(".", "\\.")}`, "i"));
    }
  });

  it("keeps CLI-native stores outside the LAX encryption claim", () => {
    const docs = read("docs/provider-auth.md");
    const ui = [
      read("public/app.html"),
      read("public/js/settings-anthropic.js"),
      read("public/js/settings-xai.js"),
    ].join("\n");

    for (const path of [".claude/.credentials.json", ".codex/auth.json", ".grok/auth.json"]) {
      expect(docs).toContain(path);
    }
    expect(ui).toMatch(/CLI-native[^\n]*(?:does not encrypt|not encrypted by LAX)/i);
    expect(docs).toMatch(/already exists[\s\S]*uses it unchanged[\s\S]*does not load or\s+mirror/i);
    expect(read("public/app.html")).toMatch(/never overwrites an existing CLI store by default/i);
  });

  it("documents fail-closed migration and unreachable degraded mode", () => {
    const docs = read("docs/provider-auth.md");
    expect(docs).toMatch(/writes fail closed/i);
    expect(docs).toMatch(/legacy plaintext[\s\S]*rewritten in place/i);
    expect(docs).toMatch(/no production route, setting, or environment\s+variable[\s\S]*not\s+reachable/i);
  });
});
