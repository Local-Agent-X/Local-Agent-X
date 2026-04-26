#!/usr/bin/env node
// Mass-migrate console.* calls to the structured logger across src/.
//
// - Replaces console.log/info -> logger.info, console.warn -> logger.warn,
//   console.error -> logger.error, console.debug -> logger.debug
// - Adds `import { createLogger } from "<rel>/logger.js";` and
//   `const logger = createLogger("<ns>");` after the existing import block.
// - Idempotent: skips files that already import from a logger.js path.
// - Hardcoded exclude list — other agents own those files.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

// Files OWNED by other agents — DO NOT TOUCH.
const EXCLUDE = new Set([
  // Telemetry agent
  "src/tool-executor.ts",
  "src/providers/run-standard.ts",
  "src/providers/run-standard-helpers.ts",
  "src/providers/run-anthropic.ts",
  "src/providers/run-anthropic-helpers.ts",
  "src/agent-codex/run-http.ts",
  "src/agent-codex/run-http-helpers.ts",
  "src/routes/chat.ts",
  "src/agent-guards.ts",
  // Route splitter
  "src/routes/bridges.ts",
  "src/routes/settings.ts",
  // Foundation / off-limits
  "src/logger.ts",
  "src/retry-telemetry.ts",
].map(normalizeRel));

function normalizeRel(p) {
  return p.replace(/\\/g, "/");
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function relFromRepo(absPath) {
  return normalizeRel(path.relative(REPO_ROOT, absPath));
}

function nsFromRel(relPath) {
  // src/voice/audio-ws.ts -> voice.audio-ws
  // src/index.ts          -> index
  let p = relPath.replace(/^src\//, "").replace(/\.ts$/, "");
  return p.split("/").join(".");
}

function loggerImportPath(relSrcPath) {
  // relSrcPath like "voice/audio-ws.ts" -> compute relative to src/logger.ts
  const fromDir = path.posix.dirname(relSrcPath);
  let rel = path.posix.relative(fromDir, "logger.js");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function alreadyMigrated(text) {
  return /from\s+["'](?:\.{1,2}\/)+logger\.js["']/.test(text);
}

function hasConsoleCalls(text) {
  return /\bconsole\.(log|warn|error|info|debug)\s*\(/.test(text);
}

function replaceConsole(text) {
  // Order: replace longer/specific names first to avoid partial overlap (none here, but safe).
  // We only match `console.X(` to avoid hitting strings like "console.log" mentions in comments-with-paren.
  let out = text;
  // Handle empty `console.X()` first → `logger.X("")` (logger requires a msg arg).
  out = out.replace(/\bconsole\.log\s*\(\s*\)/g, 'logger.info("")');
  out = out.replace(/\bconsole\.info\s*\(\s*\)/g, 'logger.info("")');
  out = out.replace(/\bconsole\.warn\s*\(\s*\)/g, 'logger.warn("")');
  out = out.replace(/\bconsole\.error\s*\(\s*\)/g, 'logger.error("")');
  out = out.replace(/\bconsole\.debug\s*\(\s*\)/g, 'logger.debug("")');
  out = out.replace(/\bconsole\.log\s*\(/g, "logger.info(");
  out = out.replace(/\bconsole\.info\s*\(/g, "logger.info(");
  out = out.replace(/\bconsole\.warn\s*\(/g, "logger.warn(");
  out = out.replace(/\bconsole\.error\s*\(/g, "logger.error(");
  out = out.replace(/\bconsole\.debug\s*\(/g, "logger.debug(");
  return out;
}

function injectLoggerSetup(text, importPath, ns) {
  const importLine = `import { createLogger } from "${importPath}";`;
  const setupLine = `const logger = createLogger("${ns}");`;

  const lines = text.split("\n");

  // Find the last import statement at top of file (skipping shebang/comments/blank).
  // We insert *after* the contiguous import block at the top.
  let lastImportIdx = -1;
  let i = 0;

  // Skip optional shebang
  if (lines[0]?.startsWith("#!")) i = 1;

  // Walk through leading top-of-file region looking for imports.
  // We allow comments/blank lines interleaved with imports.
  let inMultilineComment = false;
  let scanning = true;
  while (scanning && i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (inMultilineComment) {
      if (line.includes("*/")) inMultilineComment = false;
      i++;
      continue;
    }
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inMultilineComment = true;
      i++;
      continue;
    }
    if (line === "" || line.startsWith("//")) {
      i++;
      continue;
    }
    if (line.startsWith("import ") || line.startsWith("import(")) {
      // Could be multi-line import — find its terminator (line ending with ; or " or ').
      let j = i;
      while (j < lines.length && !/;\s*$/.test(lines[j])) j++;
      lastImportIdx = j;
      i = j + 1;
      continue;
    }
    // Hit something that isn't import/comment/blank — stop.
    scanning = false;
  }

  let insertAt;
  if (lastImportIdx >= 0) {
    insertAt = lastImportIdx + 1;
  } else {
    // No imports — insert after any leading shebang/comment block.
    insertAt = i;
  }

  const insertion = ["", importLine, setupLine, ""];
  // Avoid producing two consecutive blank lines.
  if (lines[insertAt - 1]?.trim() === "") insertion.shift();
  if (lines[insertAt]?.trim() === "") insertion.pop();

  lines.splice(insertAt, 0, ...insertion);
  return lines.join("\n");
}

async function main() {
  const all = await walk(SRC_ROOT);
  const candidates = all.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  let modified = 0;
  let skippedExcluded = 0;
  let skippedNoConsole = 0;
  let skippedAlreadyMigrated = 0;
  const touched = [];

  for (const abs of candidates) {
    const rel = relFromRepo(abs);
    if (EXCLUDE.has(rel)) {
      skippedExcluded++;
      continue;
    }
    const text = await fs.readFile(abs, "utf8");
    if (!hasConsoleCalls(text)) {
      skippedNoConsole++;
      continue;
    }
    if (alreadyMigrated(text)) {
      // Still rewrite console.* so re-runs are safe, but don't re-inject the import.
      const replaced = replaceConsole(text);
      if (replaced !== text) {
        await fs.writeFile(abs, replaced, "utf8");
        modified++;
        touched.push(rel);
      } else {
        skippedAlreadyMigrated++;
      }
      continue;
    }

    const relSrc = rel.replace(/^src\//, "");
    const importPath = loggerImportPath(relSrc);
    const ns = nsFromRel(rel);

    let next = replaceConsole(text);
    next = injectLoggerSetup(next, importPath, ns);

    if (next !== text) {
      await fs.writeFile(abs, next, "utf8");
      modified++;
      touched.push(rel);
    }
  }

  console.log(`Modified: ${modified}`);
  console.log(`Skipped (excluded):         ${skippedExcluded}`);
  console.log(`Skipped (no console calls): ${skippedNoConsole}`);
  console.log(`Skipped (already migrated): ${skippedAlreadyMigrated}`);
  console.log("---");
  for (const t of touched) console.log("  " + t);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
