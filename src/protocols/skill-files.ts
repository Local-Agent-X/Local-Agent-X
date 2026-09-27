/**
 * The files a SKILL.md skill ships beside it (references/*.md, examples,
 * scripts). A vendor skill's body points into them ("see references/wrangler-
 * config.md"), but the skill folder sits in the LAX install, outside anything
 * the file tools may read — so protocol(action:"get") serves them itself,
 * confined to that one skill's folder.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_LISTED = 60;

/** Files in the skill's folder other than SKILL.md, relative, forward-slashed. */
export function skillFiles(sourcePath: string): string[] {
  const root = dirname(sourcePath);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_LISTED || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full !== sourcePath) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** A file inside the skill's folder, or an error naming what is available.
 *  Absolute paths and anything resolving outside the folder are refused. */
export function readSkillFile(sourcePath: string, file: string): { text: string } | { error: string } {
  const root = dirname(sourcePath);
  const target = resolve(root, file.replace(/\\/g, "/"));
  if (target !== root && !target.startsWith(root + sep)) return { error: `"${file}" is outside this skill's folder.` };
  try {
    if (!statSync(target).isFile()) return { error: `"${file}" is not a file in this skill.` };
    return { text: readFileSync(target, "utf8") };
  } catch {
    return { error: `No file "${file}" in this skill. Its files: ${skillFiles(sourcePath).join(", ") || "(none)"}` };
  }
}
