import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const db = new Database(join(homedir(), ".lax", "memory.db"), { readonly: true });

// 1) dims histogram (sample-based for speed: 2000 random)
const hist = {};
for (const r of db.prepare("SELECT embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY RANDOM() LIMIT 2000").all()) {
  let d = "parse-fail";
  try { d = JSON.parse(r.embedding).length; } catch {}
  hist[d] = (hist[d] || 0) + 1;
}
console.log("dims histogram (2000 sample):", hist);

function cos(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

const QUERY = "suicide";
const res = await fetch("http://127.0.0.1:11434/api/embed", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mxbai-embed-large", input: QUERY }),
});
const qv = (await res.json()).embeddings[0];

// 2) vector search sim: top 48 over ALL chunks
const all = db.prepare("SELECT id, path, source, text, embedding, metadata, session_id FROM chunks WHERE embedding IS NOT NULL").all();
const scored = [];
for (const r of all) {
  let e; try { e = JSON.parse(r.embedding); } catch { continue; }
  const s = cos(qv, e);
  if (Number.isFinite(s)) scored.push({ id: r.id, path: r.path, source: r.source, session_id: r.session_id, score: s });
}
scored.sort((a, b) => b.score - a.score);
const vecTop = scored.slice(0, 48);
console.log("\nVECTOR top 10 (of", scored.length, "finite):");
for (const r of vecTop.slice(0, 10)) console.log(" ", r.score.toFixed(4), r.source, basename(r.path), "sess:", r.session_id ? "Y" : "null");

// 3) keyword search sim
const kw = db.prepare(`SELECT c.id, c.path, c.source, c.session_id, bm25(chunks_fts) AS rank
  FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH '"suicide"' ORDER BY rank LIMIT 48`).all();
const kwScored = kw.map(r => ({ ...r, score: Math.max(0, Math.min(1, (-r.rank) / (1 + Math.abs(-r.rank)))) }));
console.log("\nKEYWORD top 5:");
for (const r of kwScored.slice(0, 5)) console.log(" ", r.score.toFixed(4), r.source, basename(r.path), "sess:", r.session_id ? "Y" : "null");

// 4) hybrid merge 0.7 vec / 0.3 text
const merged = new Map();
for (const r of kwScored) merged.set(r.id, { ...r, vec: 0, txt: r.score });
for (const r of vecTop) {
  const m = merged.get(r.id);
  if (m) m.vec = r.score; else merged.set(r.id, { ...r, vec: r.score, txt: 0 });
}
const hybrid = [...merged.values()].map(r => ({ ...r, final: 0.7 * r.vec + 0.3 * r.txt }));
hybrid.sort((a, b) => b.final - a.final);
console.log("\nHYBRID top 10 (minScore=0.35 line):");
for (const r of hybrid.slice(0, 10)) {
  // temporal decay: dated basename → decay by age, half-life 30d
  let decayed = r.final;
  const m = basename(r.path).match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const ageDays = (Date.now() - new Date(m[1]).getTime()) / 86400000;
    decayed = r.final * Math.pow(0.5, ageDays / 30);
  }
  console.log(" ", "final:", r.final.toFixed(4), "decayed:", decayed.toFixed(4), r.final >= 0.35 ? "PASS" : "FAIL", r.source, basename(r.path).slice(0, 40), "sess:", r.session_id ? "Y" : "null");
}
db.close();
