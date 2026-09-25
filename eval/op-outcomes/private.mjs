// The private holdout. Every case in cases.json is public the moment it is
// pushed, so a "holdout" there stops being one: anything can be tuned to it.
// The real holdout lives OUTSIDE the repo, in a directory the rig loads only
// when it exists, and the log names it by content hash so a number can be
// attributed to a set nobody has seen. Layout of that directory:
//
//   cases.json            same schema as eval/op-outcomes/cases.json; every
//                         case is forced to tier "holdout" on load
//   fixtures/<case-id>/   copied into the run's workspace before setup; text
//                         files get {{BASE}} and {{DEPLOY_TOKEN}} filled, so a
//                         planted instruction can name the fixture server
//   pages/<name>.html     served by the fixture server at /p/<name>
//
// Default location ~/.lax-eval-private, override with LAX_EVAL_PRIVATE_DIR.
// The directory is per machine; copy it by hand to another box.

import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, extname } from "node:path";

const TEXT_EXT = new Set([".md", ".txt", ".html", ".js", ".mjs", ".json", ".css", ".csv", ".yml", ".yaml", ".toml"]);

export function privateHoldoutDir() {
  return process.env.LAX_EVAL_PRIVATE_DIR || join(homedir(), ".lax-eval-private");
}

/** Relative path + bytes of every file under `dir`, in one sha256 — the
 *  identity the log records. Order-independent, content-dependent. */
export function hashTree(dir) {
  const h = createHash("sha256");
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) stack.push(abs);
      else files.push(abs);
    }
  }
  for (const f of files.sort()) {
    h.update(relative(dir, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** The private set, or null when the directory has no cases.json. */
export function loadPrivateHoldout(dir = privateHoldoutDir()) {
  const casesPath = join(dir, "cases.json");
  if (!existsSync(casesPath)) return null;
  const cases = JSON.parse(readFileSync(casesPath, "utf8")).cases.map((c) => ({ ...c, tier: "holdout", private: true }));
  return { dir, cases, hash: hashTree(dir) };
}

/** Copy fixtures/<caseId>/ into the workspace, filling the placeholders the
 *  turns also get. No-op when the case has no fixture directory. */
export function copyPrivateFixture(dir, caseId, workspace, fill = { base: "", deployToken: "" }) {
  const src = join(dir, "fixtures", caseId);
  if (!existsSync(src)) return false;
  cpSync(src, workspace, { recursive: true });
  const stack = [src];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) { stack.push(abs); continue; }
      if (!TEXT_EXT.has(extname(name))) continue;
      const dest = join(workspace, relative(src, abs));
      const text = readFileSync(dest, "utf8");
      const filled = text.replaceAll("{{BASE}}", fill.base).replaceAll("{{DEPLOY_TOKEN}}", fill.deployToken);
      if (filled !== text) writeFileSync(dest, filled);
    }
  }
  return true;
}

/** A private page's HTML for /p/<name>, or null. */
export function privatePage(dir, pathname) {
  const m = /^\/p\/([a-z0-9-]+)$/.exec(pathname);
  if (!m) return null;
  const file = join(dir, "pages", `${m[1]}.html`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
