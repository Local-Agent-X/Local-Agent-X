# phone-push

**Owns:** Ringing the paired phone like a text when the user inbox gets an item of a kind the user chose in the phone app, even with the app closed. The phones' registrations (`<lax data dir>/phone-push.json`, `store.ts`), sealing an alert with the phone's key (`seal.ts`), handing it to Expo's push service (`send.ts`), and the phone's `push_register` / `push_unregister` frames on the chat socket (`index.ts` `handlePushFrame`, called by `src/chat-ws/message-router.ts`).
**Does not own:** The inbox and what goes in it (`src/inbox/`; this module only hears its `inbox:posted` bus event). The wire format: agentxos `push.ts`, vendored at `src/broker-transport/vendor/push.ts`. The phone's half: agentxos-mobile `app/src/alerts/`.
**Entry:** `index.ts` — `startPhonePush` (boot, `src/server/lifecycle.ts`), `handlePushFrame`, `alertPhones`, `phonePushStore`.

## Invariants
- What an alert says never leaves this machine readable. Each push carries `data` only, sealed AES-256-GCM with the key the phone generated (`seal.ts`); no title or body goes to Expo or Google.
- A phone's key is stored encrypted under the vault's master key (`store.ts`), never in the clear, and never logged; a log names a phone by the first characters of its token.
- An alert never fails the inbox: `alertPhones` never throws, and the inbox emits the bus event without waiting on it.
- Local-only mode sends nothing.
- A token Expo reports as `DeviceNotRegistered` is dropped.

## Tests
`npx vitest run src/phone-push src/inbox src/chat-ws/message-router.inbox.test.ts src/event-bus-topics.test.ts src/net/network-primitive-registry.test.ts` (PowerShell on Windows)
