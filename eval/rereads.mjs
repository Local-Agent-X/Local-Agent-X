// Re-reads after compaction: a model that lost its history re-reads files it
// already has. Counts distinct read targets vs total reads, and how many reads
// land in turns whose view was compacted.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

const evDir = process.argv[2];
for (const slug of readdirSync(evDir)) {
  const ops = join(evDir, slug, "operations");
  if (!existsSync(ops)) continue;
  const counts = new Map();
  let reads = 0, readsWhileCompacted = 0, compactedTurns = 0, turns = 0;
  for (const op of readdirSync(ops)) {
    const turnsDir = join(ops, op, "op-turns");
    if (!existsSync(turnsDir)) continue;
    for (const f of readdirSync(turnsDir)) {
      const j = JSON.parse(gunzipSync(readFileSync(join(turnsDir, f))).toString());
      turns++;
      const compacted = j.turn?.providerState?.viewCompacted === true;
      if (compacted) compactedTurns++;
      for (const m of j.messages ?? []) {
        for (const t of m.content?.toolCalls ?? []) {
          if (t.name !== "read") continue;
          let p = "";
          try { p = String(JSON.parse(t.arguments).path ?? "").replace(/\\/g, "/").toLowerCase(); } catch { /* ignore */ }
          if (!p) continue;
          reads++;
          if (compacted) readsWhileCompacted++;
          counts.set(p, (counts.get(p) ?? 0) + 1);
        }
      }
    }
  }
  if (!reads) continue;
  const distinct = counts.size;
  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(
    `${slug.padEnd(14)} turns=${String(turns).padStart(3)} compacted=${String(compactedTurns).padStart(3)}` +
    `  reads=${String(reads).padStart(3)} distinct=${String(distinct).padStart(2)}` +
    `  reads/file=${(reads / distinct).toFixed(1)}  most-read=${worst[1]}x ${worst[0].split("/").pop()}`,
  );
}
