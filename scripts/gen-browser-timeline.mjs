#!/usr/bin/env node
/**
 * Generate public/js/agentxos-timeline.js — the web client's copy of the shared
 * lane-replace rule, compiled from src/broker-transport/vendor/timeline.ts.
 *
 * WHY: the rule that applies a `replace` frame to a turn's timeline must be the same
 * function everywhere a turn is drawn, or a live client and a replaying one render the
 * same turn differently. The server (chat-ws/state.ts) and the phone import the vendored
 * TypeScript; the web client loads classic scripts, so it gets this generated one
 * (window.AgentxosTimeline) instead of a hand-kept twin.
 *
 *   Regenerate:  node scripts/gen-browser-timeline.mjs
 *   Verify:      npm run check:browser-timeline   (--check; runs inside npm build)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = "src/broker-transport/vendor/timeline.ts";
const OUT = "public/js/agentxos-timeline.js";

function render() {
  // Line endings normalized on both sides: a Windows checkout has CRLF sources, and the
  // output must be the same bytes on every machine for --check to mean anything.
  const source = readFileSync(join(repoRoot, SOURCE), "utf-8").replace(/\r\n/g, "\n");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, newLine: ts.NewLineKind.LineFeed },
  });
  const body = outputText.replace(/\r\n/g, "\n").replace(/^"use strict";\n/, "").trimEnd();
  return [
    `// GENERATED from ${SOURCE} by scripts/gen-browser-timeline.mjs. Do not edit:`,
    "// change the rule in agentxos, re-sync the vendor folder, then regenerate.",
    "(function () {",
    "  var exports = {};",
    body.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n"),
    "  window.AgentxosTimeline = exports;",
    "})();",
    "",
  ].join("\n");
}

const next = render();
const outPath = join(repoRoot, OUT);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf-8").replace(/\r\n/g, "\n");
  } catch {
    /* missing counts as stale */
  }
  if (current !== next) {
    console.error(`${OUT} is stale: run node scripts/gen-browser-timeline.mjs and commit the result.`);
    process.exit(1);
  }
  console.log(`${OUT} is current.`);
} else {
  writeFileSync(outPath, next);
  console.log(`wrote ${OUT}`);
}
