# Reaching Local Agent X from an app, a program or a device

For an agent building something that must reach the user's agents, speech or
files from outside the chat: an app with an assistant panel, a simulator, a
script, hardware such as glasses. Pick the row for where the code runs. Each
answer names the code it was checked against; read this instead of the server
source.

| Where the code runs | Use | Never |
|---|---|---|
| A page LAX serves at `/apps/<name>/`, on the desktop | `window.lax.chat` | `/api/*`, the operator token, a proxy |
| A program on this computer (script, PC simulator) | Make it an app page if it can be one; otherwise see below | Reading `authToken` from the data dir's `config.json` |
| A device off this computer (phone, glasses) | The broker, the way the phone pairs | A LAN port on this machine |

## An app page

LAX injects `window.lax.chat` into every page it serves from
`workspace/apps/<name>/` (`src/server/app-chat-inject.ts`, client in
`public/js/app-chat-client.js`, server in `src/routes/app-chat.ts`):

```js
const reply = lax.chat('assistant', 'What is in front of me?', { persona: 'You are the glasses assistant.' });
for await (const e of reply) { /* {type:'delta'|'replace'|'needs_approval'|'error'|'done'} */ }
const text = await reply.text();   // or the whole reply at once
await lax.chatHistory('assistant'); await lax.chatStop('assistant');
```

The user approves each app once, on a card in their inbox. Until then a call
rejects with `error.code === 'needs_approval'`; show "Approve this app in Local
Agent X" with a retry. What approving opens is in `docs/app-chat-security.md`.

An app page holds no credential for anything else under `/api/`: no
transcription, no files, no settings. Its tokens open only its own chat
threads and the connector proxy (`src/server/app-connector-auth.ts`). Inside
the page, use the browser: `getUserMedia` for a camera or microphone, and
`speechSynthesis` to speak a reply. Speech recognition is not available in the
desktop app's browser (no speech key in Electron), so a simulator takes the
spoken words as typed text, or records audio for a later step.

A device simulator fits here: camera, a typed stand-in for speech, replies
through `lax.chat`, spoken with `speechSynthesis`. It runs with nothing new
installed and tests the conversation before any hardware exists.

## A program on this computer

Every `/api/*` route needs `Authorization: Bearer <token>`; only
`/api/health` and the auth status routes are exempt. Coming from 127.0.0.1
skips rate limits, not the token. A POST that carries an `Origin` header must
come from a loopback origin (`src/server/request-auth.ts`).

There is no scoped token to give a program. The only credential is the user's
operator token, which carries all of their powers. A program that needs it is
the user's decision: say so and let them paste it into the program's own
config (Settings → Security → Operator credential). Never read it from the
data dir, copy it into code, or commit it.

With that token, the routes a client uses:

- `POST /api/chat`: one chat turn, streamed back as server-sent events
  (`src/routes/chat.ts`, body schema `ChatRequestSchema` in
  `src/route-schemas.ts`).
- `POST /api/voice/dictate-once`: the raw audio bytes as the body, any format
  ffmpeg reads, up to 25 MB; returns `{ "text": "..." }`, where `""` means no
  speech was heard. 503 when ffmpeg is missing
  (`src/routes/bridges/voice-dictate.ts`).
- `/ws/voice?token=...`: the full voice loop (listen, agent turn, spoken
  reply) the desktop's voice mode uses (`public/js/chat-voice-mic.js`).

There is no HTTP text-to-speech route. Speech comes back through `/ws/voice`
or the broker's voice channel.

An agent's own `http_request` to this server signs in with the agent's
internal token. A 200 it gets says the route works, not that the program
will be let in.

## A device off this computer

A phone, glasses or any other device reaches the desktop only through the
broker (`src/broker-transport/`): it pairs once, then carries chat and voice
(the same listen, agent, speak loop as `/ws/voice`) over that link. Nothing
listens on the LAN for it. A new device kind is new work there, not a port to
open.
