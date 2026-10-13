# providers

**Owns:** Per-provider metadata and wire plumbing — the `PROVIDERS` registry, provider ids, model catalog and capability stores, the HTTP / Ollama / Codex wire adapters, and per-provider history cleanup before a request is sent.
**Does not own:** Per-turn transport adapters (how a turn streams and finalizes) → `src/canonical-loop/adapters/`; credentials and sign-in → `src/auth/`; the whole per-turn request pipeline → `src/agent-request/`.
**Entry:** no index. Public files: `registry.ts` (`PROVIDERS`), `provider-ids.ts` (`PROVIDER_IDS`, `ProviderId`), `sanitize.ts` (history cleanup), `adapters/` behind `adapter/base-adapter.ts`, `model-catalog.ts`, `resolve-provider-context.ts`.

## Invariants
- Adding a provider = one `PROVIDER_IDS` entry + one `PROVIDERS` entry; every other site reads `PROVIDERS`. Never add an `if (provider === ...)` branch at a call site — the `transport` discriminant encodes the Anthropic Messages vs OpenAI-compat split.
- `anthropic` (subscription sign-in) and `anthropic-api` (saved key) are distinct ids sharing one runtime; what the user picked is what runs, is billed and is sized.
- `sanitize.ts` is the only place chat history is truncated and digested per channel; its keep counts and clip boundaries are golden-pinned.
- Adapters speak the wire format only; routing, failover and credential choice happen above them.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| `provider-ids.ts` / `registry.ts` | `src/agent-request/resolve-provider.ts`, `src/auth/resolve.ts`, `src/routes/settings/providers.ts`, `src/canonical-loop/runtime-failover.ts` | `chat-models.test.ts`, `model-catalog.test.ts`, `resolve-provider-context.test.ts` |
| `adapters/openai-http.ts`, `adapters/ollama-native.ts` | `src/canonical-loop/adapters/openai-compat/chat-transport.ts` | `adapters/openai-http.test.ts`, `adapters/ollama-native.test.ts` |
| `sanitize.ts` | `src/agent-request/prepare-request.ts`, `src/context-manager/compaction-policy.ts` | `sanitize.golden.test.ts` |
| `adapters/openai-param-support.ts` | `adapters/openai-param-rejections.ts` | `adapters/openai-param-support.test.ts` |

## Tests
`npx vitest run src/providers` (PowerShell on Windows)
