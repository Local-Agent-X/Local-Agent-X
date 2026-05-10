import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GitFn = (...args: string[]) => Promise<string>;

export async function resolveConflicts(syncDir: string, git: GitFn): Promise<void> {
  try {
    const status = await git("status", "--porcelain");
    const conflicted = status.split("\n").filter(l => l.startsWith("UU ") || l.startsWith("AA "));
    for (const line of conflicted) {
      const file = line.slice(3).trim();
      if (file.endsWith(".md")) {
        const fullPath = join(syncDir, file);
        if (existsSync(fullPath)) {
          const cleaned = readFileSync(fullPath, "utf-8").replace(/<<<<<<< HEAD\n/g, "").replace(/=======\n/g, "").replace(/>>>>>>> .*\n/g, "");
          const lines = Array.from(new Set(cleaned.split("\n").map(l => l.trim()).filter(Boolean)));
          writeFileSync(fullPath, lines.join("\n") + "\n");
        }
      }
      await git("add", file);
    }
    if (conflicted.length > 0) await git("commit", "-m", "auto-merge: union merge resolved conflicts");
  } catch {}
}
