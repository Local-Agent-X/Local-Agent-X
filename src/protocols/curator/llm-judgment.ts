import { dispatch } from "../../llm-dispatch.js";
import type { LLMInput, LLMJudgment } from "./types.js";

export async function askAuxiliaryModel(input: LLMInput): Promise<LLMJudgment> {
  // Skip the LLM call when there's nothing to evaluate — the report still
  // ships with the mechanical sections.
  if (input.clusters.length === 0 && input.searchMisses.length === 0) {
    return { consolidations: "(no clusters detected)", catalogGaps: "(no recent search misses)" };
  }

  const sections: string[] = [];

  if (input.clusters.length > 0) {
    sections.push("# Candidate clusters (high embedding similarity, may be redundant)");
    for (const c of input.clusters) {
      sections.push(`\n## Cluster (cohesion ${c.cohesion.toFixed(2)})`);
      for (const name of c.members) {
        const p = input.protocolsByName[name];
        if (!p) continue;
        sections.push(`- **${p.name}** — ${p.description} [triggers: ${p.triggers.slice(0, 3).join(", ")}]`);
      }
    }
  }

  if (input.searchMisses.length > 0) {
    sections.push(`\n# Recent search misses (queries that returned no hits)`);
    for (const m of input.searchMisses.slice(0, 15)) {
      sections.push(`- "${m.query}" (${m.count}×)`);
    }
  }

  const prompt = `You are a protocol-catalog curator. Output ONLY two markdown sections — no preamble, no closing remarks.

Below is the current state of a protocol catalog (a library of reusable agent workflows). Your job is to flag (a) clusters that could be consolidated into a single umbrella protocol, and (b) search queries that suggest the catalog is missing a useful protocol.

INPUT:
${sections.join("\n")}

OUTPUT FORMAT — exactly these two sections, no others:

## Consolidation candidates
For each cluster, one bullet: \`- Merge [A, B, C] → propose name "X"; keep the distinct rules from each as separate steps.\` Skip clusters where the members serve genuinely different purposes despite similar wording — flag those as \`- KEEP SEPARATE: [A, B] — reason: ...\`.

## Catalog gaps
For each cluster of related misses, one bullet: \`- Build a protocol for: "...task description...". Triggers: [phrase1, phrase2]. Rationale: appeared X times.\` Only include misses that look like a real recurring need, not one-off odd queries.

Be terse. Be concrete. No filler.`;

  const out = await dispatch({
    prompt,
    provider: "auto",
    preferEnvKeys: true,
    rejectOAuth: false,
    temperature: 0,
    maxTokens: 800,
    timeoutMs: 30_000,
  });

  if (!out) {
    return {
      consolidations: "(LLM unavailable — see raw clusters above for manual review)",
      catalogGaps: "(LLM unavailable — see raw search misses above for manual review)",
      skipped: "no provider responded; report contains mechanical sections only",
    };
  }

  // Split on the two known headings. Fall back to "everything to consolidations"
  // if the model didn't follow the schema.
  const consolidationsMatch = out.match(/##\s*Consolidation candidates\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  const gapsMatch = out.match(/##\s*Catalog gaps\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  return {
    consolidations: consolidationsMatch?.[1].trim() || out.trim(),
    catalogGaps: gapsMatch?.[1].trim() || "(no section emitted)",
  };
}
