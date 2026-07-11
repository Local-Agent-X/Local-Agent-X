import {
  AssociationContext,
  AssociationType,
  AssociativeStore,
} from "./types.js";
import { overlapScore, timeProximity } from "./scoring.js";

export function upsertAssociation(
  store: AssociativeStore,
  from: string,
  to: string,
  type: AssociationType,
  strength: number,
  now: number,
): void {
  const existing = store.associations.find(
    (a) => a.type === type &&
      ((a.from === from && a.to === to) || (a.from === to && a.to === from)),
  );
  if (existing) {
    existing.strength = Math.min(1, existing.strength + strength * 0.3);
    existing.lastAccessed = now;
  } else {
    store.associations.push({
      from,
      to,
      type,
      strength: Math.min(1, strength),
      lastAccessed: now,
      created: now,
    });
  }
}

export function buildAssociations(
  store: AssociativeStore,
  memoryId: string,
  context: AssociationContext,
): void {
  let node = store.nodes.find((n) => n.memoryId === memoryId);
  if (!node) {
    node = { memoryId, content: "", context, created: Date.now() };
    store.nodes.push(node);
  } else {
    node.context = context;
  }

  const now = Date.now();

  const sorted = [...store.nodes]
    .filter((n) => n.memoryId !== memoryId)
    .sort((a, b) => b.created - a.created);
  const previous = sorted[0];
  if (previous && now - previous.created < 10 * 60 * 1000) {
    upsertAssociation(store, previous.memoryId, memoryId, "sequential", 0.8, now);
  }

  for (const other of store.nodes) {
    if (other.memoryId === memoryId) continue;
    const oc = other.context;

    if (timeProximity(context.timeOfDay, oc.timeOfDay) > 0.8) {
      upsertAssociation(store, memoryId, other.memoryId, "temporal",
        timeProximity(context.timeOfDay, oc.timeOfDay) * 0.6, now);
    }

    if (context.sessionTopic && oc.sessionTopic &&
        context.sessionTopic.toLowerCase() === oc.sessionTopic.toLowerCase()) {
      upsertAssociation(store, memoryId, other.memoryId, "topical", 0.7, now);
    }

    if (context.emotionalState && oc.emotionalState &&
        context.emotionalState === oc.emotionalState) {
      upsertAssociation(store, memoryId, other.memoryId, "emotional", 0.5, now);
    }

    const entityOvlp = overlapScore(context.entities, oc.entities);
    if (entityOvlp > 0.2) {
      upsertAssociation(store, memoryId, other.memoryId, "entity", entityOvlp, now);
    }

    if (context.activeProject && oc.activeProject &&
        context.activeProject.toLowerCase() === oc.activeProject.toLowerCase()) {
      upsertAssociation(store, memoryId, other.memoryId, "project", 0.7, now);
    }

    const toolOvlp = overlapScore(context.toolsUsed, oc.toolsUsed);
    if (toolOvlp > 0.2) {
      upsertAssociation(store, memoryId, other.memoryId, "tool", toolOvlp * 0.6, now);
    }
  }
}
