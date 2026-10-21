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
| Splitting frames over the data-channel cap, and the chat link hello | `chunks.ts` |
| HTTP tunnel frames, body cap | `tunnel.ts` |
| Chat frames and the events the phone reads | `chat.ts` |
| The desktop's background jobs: events, snapshot, controls | `workers.ts` |
| The user inbox: snapshot, live changes, the phone's answers | `inbox.ts` |
| Approvals on the chat channel | `approval.ts` |
| How a `replace` frame rewrites a turn's timeline | `timeline.ts` |
| Voice control plane | `voice.ts` |
| Offline apps: the state snapshot, the bundle, the POST /state body and the merge both devices run | `apps.ts` |
| The sessions list row and the session-id pattern | `sessions.ts` |
| Broker signaling client | `broker-client.ts`, `connect-url.ts`, `parse-server-frame.ts`, `socket-adapter.ts`, `index.ts` |
| Account API client and device-code login (sign in, register, pair, renew) | `account-api.ts`, `device-code-login.ts` |

## Changing a contract

1. Change it in agentxos, following the compatibility rule at the top of
   `packages/protocol/src/index.ts`. Within a protocol version, only add.
2. `AGENTXOS_DIR=<agentxos checkout> node scripts/check-vendor-sync.mjs --sync` copies
   every file here, adds any protocol module new upstream, adapts import specifiers to
   this repo's Node16 ESM (`.js` suffixes; the protocol package becomes
   `./protocol.js`), and records the hashes.
3. Re-sync the phone the same way (`app/scripts/check-vendor-sync.mjs --sync`).

`npm run build` runs `check:vendor-sync`. It fails when a file's code no longer matches
its recorded hash, when a relative import names a file the copy lacks, and, when an
agentxos checkout is found, when it no longer matches upstream or an upstream protocol
module isn't vendored. Comments and formatting don't count; code does.

The web client loads classic scripts, so it gets `timeline.ts` as the generated
`public/js/agentxos-timeline.js` (`node scripts/gen-browser-timeline.mjs`; the build
fails while it is stale). Regenerate it after a re-sync that changes `timeline.ts`.

`src/broker-transport/chat-contract.test.ts` checks at compile time that every chat
event the desktop emits under a type the phone reads fits `chat.ts`;
`workers-contract.test.ts` does the same for the `bg_op_*` events and `workers.ts`, and
`inbox-contract.test.ts` for the inbox items and frames and `inbox.ts`.

The desktop-side glue (the `ws`-backed `SocketAdapter`, the dialers, the bridges) lives
one level up in `../`, not here.
