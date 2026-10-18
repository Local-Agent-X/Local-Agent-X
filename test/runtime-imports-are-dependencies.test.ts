// Every package the server's own code imports must be in a production install.
//
// A package listed only in devDependencies is absent from one
// (`npm ci --omit=dev`), and a static import of it crashes the module that
// holds it at load. src/language-intel imported `typescript`, a dev
// dependency, and the Terminal-Bench Linux bundle (eval/terminal-bench/)
// crashed on boot with ERR_MODULE_NOT_FOUND (2026-10-18). Today's installs
// happen to include dev packages, which is why nothing else noticed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
// The lockfile is what says whether a production install contains a package:
// a dependency of a runtime dependency (sharp, pdfjs-dist) is installed and
// its lock entry is not `dev`; a devDependency's entry is `dev` (or
// `devOptional`) and `npm ci --omit=dev` leaves it out.
const LOCK: Record<string, { dev?: boolean; devOptional?: boolean }> =
  JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")).packages;
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Why a production install would not have `name`, or null when it would. */
function missingInProduction(name: string): string | null {
  const entry = LOCK[`node_modules/${name}`];
  if (!entry) return "not in package-lock.json";
  if (entry.dev || entry.devOptional) return "dev-only: npm ci --omit=dev leaves it out";
  return null;
}

/** Files that only tests load: they may import test tooling. */
function isTestOnly(rel: string): boolean {
  return /\.test\.ts$/.test(rel) || /test-helper/.test(rel) || /(^|[\\/])__tests__[\\/]/.test(rel) || rel.endsWith(".d.ts");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (name.endsWith(".ts") && !isTestOnly(relative(ROOT, path))) out.push(path);
  }
  return out;
}

function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || BUILTIN.has(spec) || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Bare specifiers that survive compilation: value imports and re-exports, plus literal import("x"). */
function runtimeSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypes = !!clause && (clause.isTypeOnly
        || (!clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)));
      if (!onlyTypes) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) specs.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

describe("runtime imports", () => {
  it("every package src/ imports at runtime is in a production install", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      for (const spec of runtimeSpecifiers(file)) {
        const name = packageOf(spec);
        const why = name && missingInProduction(name);
        if (why) offenders.push(`${relative(ROOT, file)} imports "${spec}" (${name}: ${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner sees value imports, and the lock check tells dev-only packages apart", () => {
    // A regression in either would let the check above pass vacuously.
    const probe = join(ROOT, "src", "language-intel", "ts-provider.ts");
    expect(runtimeSpecifiers(probe)).toContain("typescript");
    expect(packageOf("@arikernel/core/sub")).toBe("@arikernel/core");
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("./local.js")).toBeNull();
    expect(missingInProduction("vitest")).toMatch(/dev-only/);
    expect(missingInProduction("better-sqlite3")).toBeNull();
    expect(missingInProduction("no-such-package-xyz")).toMatch(/not in package-lock/);
  });
});
