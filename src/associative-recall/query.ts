import {
  AssociationContext,
  AssociationWeb,
  AssociativeResult,
  AssociativeStore,
} from "./types.js";
import { overlapScore, textContains, timeProximity } from "./scoring.js";

export function recall(
  store: AssociativeStore,
  trigger: string,
  context?: Partial<AssociationContext>,
): AssociativeResult[] {
  const candidates: Map<string, { score: number; types: { type: string; strength: number }[] }> = new Map();

  for (const node of store.nodes) {
    let score = 0;
    const matchedTypes: { type: string; strength: number }[] = [];

    if (textContains(node.content, trigger) ||
        textContains(node.context.sessionTopic || "", trigger) ||
        node.context.entities.some((e) => textContains(e, trigger))) {
      score += 1;
      matchedTypes.push({ type: "content", strength: 0.8 });
    }

    if (context) {
      if (context.timeOfDay !== undefined) {
        const tp = timeProximity(context.timeOfDay, node.context.timeOfDay);
        if (tp > 0.7) { score += 1; matchedTypes.push({ type: "temporal", strength: tp }); }
      }
      if (context.sessionTopic && node.context.sessionTopic &&
          context.sessionTopic.toLowerCase() === node.context.sessionTopic.toLowerCase()) {
        score += 1;
        matchedTypes.push({ type: "topical", strength: 0.8 });
      }
      if (context.emotionalState && node.context.emotionalState === context.emotionalState) {
        score += 1;
        matchedTypes.push({ type: "emotional", strength: 0.7 });
      }
      if (context.activeProject && node.context.activeProject &&
          context.activeProject.toLowerCase() === node.context.activeProject.toLowerCase()) {
        score += 1;
        matchedTypes.push({ type: "project", strength: 0.8 });
      }
      if (context.entities && context.entities.length > 0) {
        const ovlp = overlapScore(context.entities, node.context.entities);
        if (ovlp > 0.1) { score += 1; matchedTypes.push({ type: "entity", strength: ovlp }); }
      }
      if (context.toolsUsed && context.toolsUsed.length > 0) {
        const ovlp = overlapScore(context.toolsUsed, node.context.toolsUsed);
        if (ovlp > 0.1) { score += 1; matchedTypes.push({ type: "tool", strength: ovlp }); }
      }
    }

    if (score > 0) {
      candidates.set(node.memoryId, { score, types: matchedTypes });
    }
  }

  const now = Date.now();
  const results: AssociativeResult[] = [];
  for (const [memoryId, { score, types }] of candidates.entries()) {
    const node = store.nodes.find((n) => n.memoryId === memoryId)!;
    results.push({
      memoryId,
      content: node.content,
      score,
      associations: types,
      context: node.context,
    });

    for (const assoc of store.associations) {
      if (assoc.from === memoryId || assoc.to === memoryId) {
        assoc.lastAccessed = now;
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function getAssociationWeb(
  store: AssociativeStore,
  memoryId: string,
): AssociationWeb {
  const connections: AssociationWeb["connections"] = [];
  const seen = new Set<string>();

  for (const assoc of store.associations) {
    let connectedId: string | null = null;
    if (assoc.from === memoryId) connectedId = assoc.to;
    else if (assoc.to === memoryId) connectedId = assoc.from;
    if (!connectedId) continue;

    const key = `${connectedId}:${assoc.type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const node = store.nodes.find((n) => n.memoryId === connectedId);
    connections.push({
      memoryId: connectedId,
      type: assoc.type,
      strength: assoc.strength,
      snippet: node ? node.content.slice(0, 120) : "",
    });
  }

  connections.sort((a, b) => b.strength - a.strength);
  return { center: memoryId, connections };
}

export function findByContext(
  store: AssociativeStore,
  context: Partial<AssociationContext>,
): AssociativeResult[] {
  const results: AssociativeResult[] = [];

  for (const node of store.nodes) {
    let score = 0;
    const matchedTypes: { type: string; strength: number }[] = [];

    if (context.timeOfDay !== undefined) {
      const tp = timeProximity(context.timeOfDay, node.context.timeOfDay);
      if (tp > 0.6) { score += 1; matchedTypes.push({ type: "temporal", strength: tp }); }
    }
    if (context.dayOfWeek !== undefined && node.context.dayOfWeek === context.dayOfWeek) {
      score += 1;
      matchedTypes.push({ type: "temporal", strength: 0.9 });
    }
    if (context.sessionTopic && node.context.sessionTopic &&
        node.context.sessionTopic.toLowerCase().includes(context.sessionTopic.toLowerCase())) {
      score += 1;
      matchedTypes.push({ type: "topical", strength: 0.8 });
    }
    if (context.activeProject && node.context.activeProject &&
        node.context.activeProject.toLowerCase().includes(context.activeProject.toLowerCase())) {
      score += 1;
      matchedTypes.push({ type: "project", strength: 0.8 });
    }
    if (context.emotionalState && node.context.emotionalState === context.emotionalState) {
      score += 1;
      matchedTypes.push({ type: "emotional", strength: 0.7 });
    }
    if (context.entities && context.entities.length > 0) {
      const ovlp = overlapScore(context.entities, node.context.entities);
      if (ovlp > 0) { score += 1; matchedTypes.push({ type: "entity", strength: ovlp }); }
    }
    if (context.toolsUsed && context.toolsUsed.length > 0) {
      const ovlp = overlapScore(context.toolsUsed, node.context.toolsUsed);
      if (ovlp > 0) { score += 1; matchedTypes.push({ type: "tool", strength: ovlp }); }
    }

    if (score > 0) {
      results.push({
        memoryId: node.memoryId,
        content: node.content,
        score,
        associations: matchedTypes,
        context: node.context,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
