/**
 * Context engine — orchestrates memory + smart context + system-prompt
 * assembly into the final per-turn context block.
 *
 * Re-exports the existing memoryManager.buildTurnContext entry point.
 * Future migration: actual implementation will move here once
 * memory-manager.ts is split (tracked separately).
 *
 * Why facade now (not full move): memory-manager.ts is 1k+ LOC with deep
 * dependencies. Full migration is days. The facade gives us the named
 * surface today so callers can switch their imports incrementally.
 */

// Re-export of memoryManager.buildTurnContext is awkward because it's a
// method on a class instance — can't re-export the method directly. Keep
// callers using memoryManager.buildTurnContext for now; the engine.ts
// file marks the intended boundary for the future migration.

export type TurnContextOptions = {
  userMessage: string;
  sessionId: string;
  sessionMessages: Array<{ role: string; content: string }>;
  skipDailyLog?: boolean;
  liteMode?: boolean;
  minimalMode?: boolean;
};
