// Module seals: production code outside a sealed module may import it only
// through its public entries. An agent can then learn a module from those
// files alone, and a reach into internals fails here instead of silently
// coupling two modules. (src/canonical-loop/ has its own, older seal in
// interface-seal.test.ts with the same rule.)
//
// Tests are exempt: a test legitimately pokes a module's internals, and the
// seal protects production coupling, not test reach.
//
// Add a row when a module's deep importers are down to its real public
// files. If a symbol is missing from a public entry, export it there; don't
// loosen the row. Leaf files that platform code must import directly (a
// sandbox backend, the kernel's class map) can be public entries without
// going through the barrel — that avoids import cycles at module init.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));

interface Seal {
  /** Module directory, relative to src/. */
  dir: string;
  /** Allowed import targets inside the module, relative to it, without extension. */
  publicEntries: string[];
  why: string;
}

const SEALS: Seal[] = [
  {
    dir: "ari-kernel",
    publicEntries: ["index", "tool-class-map"],
    why: "the kernel gateway; tool-class-map is a leaf the security layer reads without pulling the lifecycle in",
  },
  {
    dir: "sandbox",
    publicEntries: [
      "index", "types", "server-confine",
      // Platform cage backends: leaf modules imported directly by the code that
      // spawns under them (mcp-client, caged-spawn, the Windows settings route).
      "seatbelt", "bwrap", "win-cage", "win-cage-install", "win-cage-grants", "docker-execution-runtime",
    ],
    why: "cage selection and the platform backends; everything else (validation, denial hints, proof state) goes through index",
  },
];

const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;
const isTest = (name: string) => /\.test\.(ts|tsx|mts)$/.test(name) || /\.test-helper\.ts$/.test(name);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !isTest(entry.name)) yield full;
  }
}

function violationsFor(seal: Seal): string[] {
  const moduleDir = resolve(SRC, seal.dir);
  const allowed = new Set(seal.publicEntries.map((e) => resolve(moduleDir, e)));
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.startsWith(moduleDir + sep)) continue;
    const text = readFileSync(file, "utf8").replace(/\\\//g, "/");
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const target = resolve(file, "..", spec).replace(/\.(m|c)?[jt]sx?$/, "");
      if (target !== moduleDir && !target.startsWith(moduleDir + sep)) continue;
      const entry = target === moduleDir ? resolve(moduleDir, "index") : target;
      if (allowed.has(entry)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      out.push(`${relative(SRC, file)}:${line} → "${spec}"`);
    }
  }
  return out;
}

describe("module seals", () => {
  it.each(SEALS)("src/$dir/ is imported only through its public entries", (seal) => {
    const violations = violationsFor(seal);
    expect(
      violations,
      `deep imports into src/${seal.dir}/ (${seal.why}); import from ` +
        `${seal.publicEntries.map((e) => `${seal.dir}/${e}.js`).join(" or ")} ` +
        `and export the symbol from there if it is missing:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });
});
