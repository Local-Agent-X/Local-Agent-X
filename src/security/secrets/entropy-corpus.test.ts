// The secret scan over a corpus of real, harmless names: every file path in
// the installed dependencies, as the CDN URL an agent would download it from,
// and every package URL in the lockfile. None is a secret, so every match is a
// false alarm a user would meet as an approval card on a real download. The
// first run found 96 in ~34k (a Three.js shader file had already reached a
// user, 2026-11-03); the corpus grows with the dependencies, so a new shape is
// caught when it arrives rather than when someone is asked about it.
//
// The other direction, that real keys are still caught, is pinned by the
// random-token tests in secret-scanner.test.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanForSecrets } from "./secret-scanner.js";

/** The real node_modules: a worktree checkout resolves packages from its parent's. */
const modules = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "..");
const lockfile = join(dirname(modules), "package-lock.json");

function filePaths(dir: string, rel = "", depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) filePaths(join(dir, e.name), r, depth + 1, out);
    else out.push(r);
  }
  return out;
}

describe("the secret scan stays quiet on real, harmless names", () => {
  it("every dependency file path as a CDN URL, and every lockfile package URL", () => {
    const corpus = filePaths(modules).map((p) => `https://cdn.jsdelivr.net/npm/${p}`);
    if (existsSync(lockfile)) {
      const lock = JSON.parse(readFileSync(lockfile, "utf8")) as { packages?: Record<string, { resolved?: unknown }> };
      for (const p of Object.values(lock.packages ?? {})) if (typeof p.resolved === "string") corpus.push(p.resolved);
    }
    expect(corpus.length).toBeGreaterThan(1000);
    const alarms = corpus.flatMap((text) => scanForSecrets(text).matches.map((m) => `${m.pattern}: ${text.slice(m.startIndex, m.endIndex)}  (${text})`));
    expect(alarms).toEqual([]);
  });
});
