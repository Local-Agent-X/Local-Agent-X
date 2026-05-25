import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { createLogger } from "../../logger.js";
import { unionMerge } from "../mirror.js";

const require = createRequire(import.meta.url);
const logger = createLogger("sync.pull-files.memory");

export function pullMemoryDir(dataDir: string, syncDir: string): void {
  const syncMemDir = join(syncDir, "memory");
  const memDir = join(dataDir, "memory");
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  const remoteMemFiles = new Set<string>();
  if (existsSync(syncMemDir)) {
    let checkTaint: ((s: string) => { safe: boolean; reason?: string }) | null = null;
    try { checkTaint = require("../../sanitize.js").checkMemoryTaint; } catch {}

    // Daily chat archives (YYYY-MM-DD.md) are auto-generated transcripts
    // of the user's own conversations — already inside the trust boundary
    // when they were created. Skip taint checks on them or the filter
    // false-positives on the agent's own defensive responses (where the
    // agent quoted `<system>` tags or `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`
    // markers from an injection attempt it caught). User-curated notes
    // with any other filename still get checked.
    const isDailyChatArchive = (name: string): boolean => /^\d{4}-\d{2}-\d{2}\.md$/.test(name);

    for (const f of readdirSync(syncMemDir)) {
      if (!f.endsWith(".md")) continue;
      remoteMemFiles.add(f);
      const syncContent = readFileSync(join(syncMemDir, f), "utf-8");
      if (checkTaint && !isDailyChatArchive(f)) {
        const t = checkTaint(syncContent);
        if (!t.safe) { logger.warn(`[sync] Rejected ${f}: ${t.reason}`); continue; }
      }
      const localPath = join(memDir, f);
      if (existsSync(localPath)) {
        writeFileSync(localPath, unionMerge(readFileSync(localPath, "utf-8"), syncContent), "utf-8");
      } else {
        writeFileSync(localPath, syncContent, "utf-8");
      }
    }
  }
  for (const f of readdirSync(memDir)) {
    if (f.endsWith(".md") && !remoteMemFiles.has(f)) {
      logger.info(`[sync] Deleting ${f} (removed from remote)`);
      unlinkSync(join(memDir, f));
    }
  }
}

export function pullToolPolicy(dataDir: string, syncDir: string): void {
  const syncPolicy = join(syncDir, "tool-policy.json");
  if (!existsSync(syncPolicy)) return;
  try {
    const remote = JSON.parse(readFileSync(syncPolicy, "utf-8"));
    const localPath = join(dataDir, "tool-policy.json");
    if (existsSync(localPath)) {
      const local = JSON.parse(readFileSync(localPath, "utf-8"));
      const localIds = new Set((local.rules || []).map((r: any) => r.id));
      for (const rule of (remote.rules || [])) {
        if (!localIds.has(rule.id)) local.rules.push(rule);
      }
      writeFileSync(localPath, JSON.stringify(local, null, 2), "utf-8");
    } else {
      writeFileSync(localPath, readFileSync(syncPolicy, "utf-8"));
    }
  } catch { writeFileSync(join(dataDir, "tool-policy.json"), readFileSync(syncPolicy, "utf-8")); }
}
