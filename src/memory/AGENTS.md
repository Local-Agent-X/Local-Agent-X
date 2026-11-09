# memory

**Owns:** Long-term memory storage and recall — `MemoryIndex` (chunking, embeddings, hybrid FTS5 + sqlite-vec search, facts, entities), `MemoryManager` (context build, recall, extraction, persistence) and `SessionStore` (chat transcripts under the data dir).
**Does not own:** Persona/cognition → `src/cognition/`; embedding backends → `src/embedding-providers/`; chat-export ingest → `src/conversation/`; token-budget compaction → `src/context-manager/`.
**Entry:** `index.ts` — `MemoryIndex` (`index-core.ts`), `MemoryManager` (`manager.ts`), `SessionStore` (`session-store.ts`), `createMemoryTools`. Routes and background jobs may use the lower modules directly.

## Invariants
- Every memory write goes through `runMemoryGate` / `appendToDailyLogSafely` (`write-safely.ts`): taint check → sanitize → secret redaction → write. Callers may raise the threshold, never skip the chain.
- Schema changes are migrations in `index-schema-migrations.ts`; `index-schema.ts` must keep working when FTS5 or sqlite-vec is unavailable (that search mode degrades, nothing throws).
- Vectors are only comparable within one provider+model; `index-embedding-reconcile.ts` records the signature and a switch goes through the re-embed path (`index-core-reembed.ts`), not a schema edit.
- Every change to a fact is logged by SQLite triggers in `fact_events` (`fact-events.ts`) and can be undone (`fact-undo.ts`). Set who is acting with `withFactActor`. Upkeep never deletes a fact: the only delete is the user's explicit erase (`index-forget.ts` `forgetFacts`), which scrubs the log and tells sync never to bring it back.
- Every end of a fact goes through `invalidateFact`, which checks who may end what: a resolver needs `resolverMayEnd`, a session no person started (`actsWithoutUser`) may end only what a model wrote.
- The facts layer is snapshotted daily to `memory-backups/` and restored from there when the database cannot be opened (`db-backup.ts`).
- Recalled text enters the prompt as untrusted data (`asRecalledData` in `src/context/system-prompt-builder.ts`), never as instructions.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `write-safely.ts` | `src/sanitize.ts` (`checkMemoryTaint`), `src/security/secrets/index.ts` (`redact`) | `write-safely.test.ts` |
| `index-schema.ts` | `index-schema-migrations.ts`, `index-sync.ts` | `index-schema-migrations.test.ts` |
| `session-store.ts` / `session-message-log.ts` | `src/routes/chat/`, `src/sync/` | `session-store-metadata.test.ts`, `session-provenance-contract.test.ts` |
| `index-facts-invalidate.ts` (who may end a fact) | `fact-events.ts`, `fact-undo.ts`, `supersede-sweep.ts`, `tools/facts.ts` | `fact-events.test.ts`, `supersede-sweep.test.ts` |
| `facts` columns | `fact-events.ts` (its triggers copy every column), `db-backup.ts`, `src/sync/facts-sync.ts` | `fact-events.test.ts`, `db-backup.test.ts` |
| `types.ts` (`MemoryConfig`, `FactKind`) | `src/routes/memory.ts`, `src/memory/tools.ts` | none |

## Tests
`npx vitest run src/memory` (PowerShell on Windows)
