#!/usr/bin/env node
/**
 * Ban `require(...)` in src/**\/*.ts.
 *
 * The project is ESM ("type":"module"). `require` is undefined at runtime,
 * so an inline `require("node:fs")` throws ReferenceError. Three live bugs
 * in one day landed because the throw was caught by surrounding
 * `try { ... } catch { return false }` patterns and silently downgraded a
 * successful operation to a failure — see build-app-spawn.ts integrity
 * check (47d6900). This check is cheap and catches the pattern before it
 * ships.
 *
 * For optional native modules that must be loaded conditionally, use
 * `import { createRequire } from "node:module"; const require =
 * createRequire(import.meta.url)` at the top of the file. The literal
 * string "createRequire" appearing nearby makes the intent obvious and
 * the AST walker below permits the `require` reference once it's bound
 * to a local const from createRequire (it only flags `require` calls
 * that resolve to no local binding).
 *
 * Why AST instead of grep: avoids false positives on string literals
 * (e.g. security-audit.ts:80 has `require('crypto')` inside a
 * remediation MESSAGE, not actual code) and comments.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = join(repoRoot, "src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function findViolations(filePath) {
  const text = readFileSync(filePath, "utf-8");
  const src = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  // Collect names introduced by `const require = createRequire(...)`
  const localRequireNames = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && callee.text === "createRequire") {
        if (ts.isIdentifier(node.name)) localRequireNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  const hits = [];
  const check = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      // Plain `require(...)` with no createRequire binding above = ESM bug
      if (name === "require" && !localRequireNames.has("require")) {
        const { line, character } = src.getLineAndCharacterOfPosition(node.getStart());
        hits.push({ line: line + 1, col: character + 1, snippet: node.getText().slice(0, 80) });
      }
    }
    ts.forEachChild(node, check);
  };
  visit(src); // ensure local-require collection finished
  check(src);
  return hits;
}

const files = walk(srcRoot);
let total = 0;
for (const f of files) {
  const hits = findViolations(f);
  if (hits.length === 0) continue;
  for (const h of hits) {
    console.error(`${relative(repoRoot, f)}:${h.line}:${h.col}  require() in ESM — use top-level import or createRequire(import.meta.url)`);
    console.error(`  ${h.snippet}`);
    total++;
  }
}
if (total > 0) {
  console.error(`\nFound ${total} require() call(s) in src/**/*.ts. The project is ESM; require is undefined at runtime.`);
  process.exit(1);
}
console.log("check-no-require: OK (no require() calls in src/)");
