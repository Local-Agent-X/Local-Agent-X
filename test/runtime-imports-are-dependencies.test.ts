// Every package the server's own code imports must be a runtime dependency.
//
// A package listed only in devDependencies is absent from a production
// install (`npm ci --omit=dev`), and a static import of it crashes the module
// that holds it at load. src/language-intel imported `typescript`, a dev
// dependency, and the Terminal-Bench Linux bundle (eval/terminal-bench/)
// crashed on boot with ERR_MODULE_NOT_FOUND (2026-10-18). Today's installs
// happen to include dev packages, which is why nothing else noticed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const RUNTIME = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

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
  it("every package src/ imports at runtime is a dependency, not a devDependency", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      for (const spec of runtimeSpecifiers(file)) {
        const name = packageOf(spec);
        if (name && !RUNTIME.has(name)) offenders.push(`${relative(ROOT, file)} imports "${spec}" (${name} is not in dependencies)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds a value import and ignores a type-only one", () => {
    // The scanner itself: a regression here would let the check above pass vacuously.
    const probe = join(ROOT, "src", "language-intel", "ts-provider.ts");
    expect(runtimeSpecifiers(probe)).toContain("typescript");
    expect(packageOf("@arikernel/core/sub")).toBe("@arikernel/core");
    expect(packageOf("node:fs")).toBeNull();
    expect(packageOf("./local.js")).toBeNull();
  });
});
