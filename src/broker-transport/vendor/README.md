# vendor/ — agentxos broker signaling client (DO NOT HAND-EDIT)

These files are a **verbatim copy** of the shared client from the `agentxos` repo:

| here | upstream (agentxos) |
| --- | --- |
| `protocol.ts` | `packages/protocol/src/index.ts` |
| `broker-client.ts` | `packages/client/src/broker-client.ts` |
| `connect-url.ts` | `packages/client/src/connect-url.ts` |
| `parse-server-frame.ts` | `packages/client/src/parse-server-frame.ts` |
| `socket-adapter.ts` | `packages/client/src/socket-adapter.ts` |
| `index.ts` | `packages/client/src/index.ts` |

The **only** change vs. upstream is import specifiers: upstream uses `.ts`
extensions and the `@agentxos/protocol` package alias (for `node --test`
type-stripping); this repo is Node16 ESM, so every relative import here uses a
`.js` extension and points at `./protocol.js` instead of the package alias.

The integration guide (`agentxos/docs/integration-lax-mobile.md`) deliberately
keeps this client small + dependency-free + secret-free so it can be copied into
both client repos rather than published. Re-sync from upstream when the broker
protocol version bumps (`BROKER_PROTOCOL_VERSION`); keep the diff to import paths
only.

The desktop-specific glue — the real `ws`-backed `SocketAdapter` and the dialer
that drives a `ScreenSession` from broker presence — lives **one level up** in
`../`, not here, so this copy stays a clean mirror.
