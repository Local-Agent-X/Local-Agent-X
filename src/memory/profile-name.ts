/**
 * The Name a profile gives: the user's in USER.md, the agent's in IDENTITY.md.
 * Read by auto-extract (which fills an empty Name line) and by the resolver's
 * same-subject rule (a fact about "Peter" and one about "the user" are about
 * the same person).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A Name line's value that is no name: blank, or the new install's "(not yet named)". */
const UNNAMED = /^(\(not yet named\))?$/i;

/** The name a profile already gives (any `- Name:` line with a real value; the files
 *  have held two), or "" when it gives none. */
export function establishedName(content: string): string {
  for (const m of content.matchAll(/^- Name:[ \t]*(.*)$/gm)) {
    const value = (m[1] ?? "").trim();
    if (!UNNAMED.test(value)) return value;
  }
  return "";
}

/** The user's name from USER.md in `memoryDir`, or "" when it gives none or cannot be read. */
export function userNameIn(memoryDir: string): string {
  const path = join(memoryDir, "USER.md");
  if (!existsSync(path)) return "";
  try {
    return establishedName(readFileSync(path, "utf-8"));
  } catch {
    // An unreadable profile names no one; the caller treats that as "no name known".
    return "";
  }
}
