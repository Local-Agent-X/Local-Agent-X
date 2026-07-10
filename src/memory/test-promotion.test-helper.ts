import type { MemoryIndex } from "./index.js";
import { createInternalMemoryContext } from "./promotion-gate.js";

export function authorizeTestFactMutations(memory: MemoryIndex): void {
  const remember = memory.rememberFact.bind(memory);
  memory.rememberFact = ((content, opts = {}) => remember(content, {
    ...opts, promotion: createInternalMemoryContext(content, "memory:retain", "test-fact"),
  })) as typeof memory.rememberFact;

  const update = memory.updateFact.bind(memory);
  memory.updateFact = ((query, content, opts = {}) => update(query, content, {
    ...opts, promotion: createInternalMemoryContext(content, `memory:update:${query}`, "test-fact"),
  })) as typeof memory.updateFact;

  const retain = memory.retain.bind(memory);
  memory.retain = ((text, sourceFile, sourceLine = 0) => retain(
    text, sourceFile, sourceLine, createInternalMemoryContext(text, "memory:retain", "test-fact"),
  )) as typeof memory.retain;

  const retainSmart = memory.retainSmart.bind(memory);
  memory.retainSmart = ((text, sourceFile, sourceLine = 0, opts = {}) => retainSmart(
    text, sourceFile, sourceLine,
    { ...opts, promotion: createInternalMemoryContext(text, "memory:retain", "test-fact") },
  )) as typeof memory.retainSmart;
}
