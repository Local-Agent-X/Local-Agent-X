import {
  ALL_ASSOCIATION_TYPES,
  AssociationContext,
  AssociationType,
  AssociationWeb,
  AssociativeResult,
  AssociativeStore,
  HALF_LIFE_MS,
} from "./types.js";
import { loadStore, saveStore } from "./persistence.js";
import { buildAssociations, upsertAssociation } from "./builder.js";
import { findByContext, getAssociationWeb, recall } from "./query.js";
import type { ModuleSignal } from "../orchestrator/types.js";

export class AssociativeMemory {
  private static instance: AssociativeMemory | null = null;
  private store: AssociativeStore;

  private constructor() {
    this.store = loadStore();
  }

  static getInstance(): AssociativeMemory {
    if (!AssociativeMemory.instance) {
      AssociativeMemory.instance = new AssociativeMemory();
    }
    return AssociativeMemory.instance;
  }

  buildAssociations(memoryId: string, context: AssociationContext): void {
    buildAssociations(this.store, memoryId, context);
    saveStore(this.store);
  }

  recall(trigger: string, context?: Partial<AssociationContext>): AssociativeResult[] {
    const results = recall(this.store, trigger, context);
    saveStore(this.store);
    return results;
  }

  getAssociationWeb(memoryId: string): AssociationWeb {
    return getAssociationWeb(this.store, memoryId);
  }

  findByContext(context: Partial<AssociationContext>): AssociativeResult[] {
    return findByContext(this.store, context);
  }

  learnAssociation(from: string, to: string, type: string, strength?: number): void {
    const assocType = ALL_ASSOCIATION_TYPES.includes(type as AssociationType)
      ? (type as AssociationType)
      : "topical";
    upsertAssociation(this.store, from, to, assocType, strength ?? 0.5, Date.now());
    saveStore(this.store);
  }

  decayAssociations(): void {
    const now = Date.now();
    this.store.associations = this.store.associations.filter((assoc) => {
      const elapsed = now - assoc.lastAccessed;
      const halfLives = elapsed / HALF_LIFE_MS;
      assoc.strength *= Math.pow(0.5, halfLives);
      return assoc.strength >= 0.05;
    });
    saveStore(this.store);
  }

  setContent(memoryId: string, content: string): void {
    const node = this.store.nodes.find((n) => n.memoryId === memoryId);
    if (node) {
      node.content = content;
      saveStore(this.store);
    }
  }

  /** Orchestrator signal: the strongest memory associated with the message. */
  signalsFor(message: string): ModuleSignal[] {
    const results = this.recall(message);
    if (results.length === 0) return [];
    const top = results[0];
    return [{ source: "associative-recall", signal: `Related memory: ${top.content} (relevance: ${top.score.toFixed(2)})`, priority: 4 + Math.round(top.score * 3), category: "recall", confidence: 1.0 }];
  }

  /** Learn a weak co-occurrence association from the message's salient words. */
  recordFrom(message: string): void {
    const words = message.split(/\s+/).filter(w => w.length > 5);
    if (words.length >= 2) {
      this.learnAssociation(words[0], words[1], "co-occurrence", 0.3);
    }
  }
}
