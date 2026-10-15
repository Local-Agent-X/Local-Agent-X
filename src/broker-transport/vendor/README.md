# vendor/ — the agentxos wire protocol and broker client (never hand-edit)

These files are a copy of the `agentxos` repo's `packages/protocol` and
`packages/client`. `UPSTREAM.json` maps each one to its upstream file and records a
hash of its code. The phone (`agentxos-mobile`, `app/src/agentxos/`) vendors the same
files, so this folder is where the desktop and the phone agree on every message they
exchange:

| Contract | File |
|---|---|
| Broker WebSocket, protocol version, compatibility rule | `protocol.ts` |
| Data-channel labels, ICE grace | `link.ts` |
| Live-screen control: input up, display hints down | `control.ts` |
| HTTP tunnel frames, body cap, chunking | `tunnel.ts` |
| Chat frames and the events the phone reads | `chat.ts` |
| Voice control plane | `voice.ts` |
| Broker signaling client | `broker-client.ts`, `connect-url.ts`, `parse-server-frame.ts`, `socket-adapter.ts`, `index.ts` |

## Changing a contract

1. Change it in agentxos, following the compatibility rule at the top of
   `packages/protocol/src/index.ts`. Within a protocol version, only add.
2. `AGENTXOS_DIR=<agentxos checkout> node scripts/check-vendor-sync.mjs --sync` copies
   every file here, adapting import specifiers to this repo's Node16 ESM (`.js`
   suffixes; the protocol package becomes `./protocol.js`), and records the hashes.
3. Re-sync the phone the same way (`app/scripts/check-vendor-sync.mjs --sync`).

`npm run build` runs `check:vendor-sync`. It fails when a file's code no longer matches
its recorded hash and, when an agentxos checkout is found, when it no longer matches
upstream. Comments and formatting don't count; code does.

`src/broker-transport/chat-contract.test.ts` checks at compile time that every chat
event the desktop emits under a type the phone reads fits `chat.ts`.

The desktop-side glue (the `ws`-backed `SocketAdapter`, the dialers, the bridges) lives
one level up in `../`, not here.
