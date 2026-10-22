# Egress consolidation: one judgment on the bytes that leave

Status: proposal, 2026-10-21. Not started. Builds on
[shell-egress-network-layer-design.md](../shell-egress-network-layer-design.md)
(the loopback proxy that is already the caged shell's only route out) and on the
taint-to-data-flow work in [taint-scoped-to-data-flow.md](taint-scoped-to-data-flow.md).

## Goal

Every byte the agent can cause to leave the machine is judged once, by one
function, on the bytes as they are actually sent, at a point no tool can route
around. Where the bytes cannot be seen (TLS from a process we do not control),
the judgment is on the destination only, and the threat model says so.

This is the precondition for ARI being a real kernel rather than one gate among
several: the kernel's decision moves to the one place every outbound byte
passes, and the kernel's string-matching exfiltration heuristics become
unnecessary instead of being patched.

## Rules the design must keep

These come from incidents already in this repo; they are what keeps the agent
from being handcuffed.

1. **Decide on bytes, never on history.** The only sticky session state is the
   set of fingerprints of sensitive content it has read, the registered secret
   values, and the session's canaries. A call is refused when its bytes carry
   one of those, or a credential shape the destination was not approved for.
   A session that has read an email can still do anything that does not move
   the email's bytes.
2. **Three verdicts.** Allow, deny with evidence, or ask. No state where a run
   is quietly restricted. One exception: a canary in an outbound request is
   proof of a hijacked agent, so it also switches the run to read-only, with a
   notice that says what fired and a one-click restore.
3. **Every block shows its exit.** What fired, what is still allowed, and the
   one control that clears it. Restarting is never the reset.
4. **Containment and utility are measured together.** Every phase below runs
   the exfiltration red-team and an agent-utility benchmark. A change that
   raises containment by lowering utility does not land.

## What exists today

Four places judge outbound traffic, and they judge different things.

| Path | Code | What it judges | When |
|---|---|---|---|
| Dispatch gate | `src/tool-execution/egress-payload.ts`, `src/tool-execution/egress-gates.ts` | The model's arguments to an egress-class tool: secret scan, taint overlap, canary, plus named local attachments | Before the tool runs |
| In-process transport | `src/tools/web-egress.ts` (`canonicalFetch`), and inline copies in `src/tools/http-request-transport.ts` and `src/tools/web-fetch.ts` | Destination only: scheme, web-access allowlist, DNS pinning, private-IP block, every redirect hop | At send |
| Browser | `src/browser/page-egress-taint.ts` via `src/browser/bridge-egress.ts` and the worker in `src/browser/egress-worker.ts` | Destination policy, then the request URL and body for taint and canary on cross-site hops | At send, per request |
| Loopback proxy | `src/net/egress-proxy-core.ts`, bound by `src/net/shell-egress-proxy.ts` | Destination only. A plain-HTTP request is fully visible but not scanned; an HTTPS request is a CONNECT, so only the host is visible | At send, for the caged shell and sandboxed MCP servers |

The dispatch gate is the only one that looks for secrets and tainted bytes in
in-process tool traffic, and it looks at what the model wrote, not at what the
tool then sends. The browser has its own payload scan with its own state
mirror. The proxy has none.

## The gaps

**G1. Bytes composed after dispatch are not judged.** The dispatch gate sees
the model's arguments. It does not see what the tool builds from them: file
contents a tool reads and uploads beyond the named attachment paths, bodies a
connector assembles in `src/routes/connector-proxy.ts`, reference images the
image and video tools upload, an email body `src/tools/email-send-tool.ts`
builds from a template plus attachments. A tool that reads a sensitive file
and sends it in one call is judged on its arguments only.

**G2. Agent-reachable code that calls the network directly.** These bypass the
in-process transport, so they skip some or all of the destination checks.

| Site | Reaches | Today |
|---|---|---|
| `src/tools/youtube-tool.ts` | Caption track, oEmbed, watch page | Global `fetch`: no allowlist, no pinning, no SSRF check. The caption URL comes from the page |
| `src/tools/image-tools/generate-image.ts`, `src/tools/image-tools/generate-video.ts` | The local image and video runtime servers | Global `fetch` to a configured loopback URL |
| `src/routes/connector-proxy.ts` | An agent-built connector's upstream | Remote: pinned and IP-checked, no payload judgment. Local upstream: global `fetch` |
| `src/protocols/marketplace.ts` | The protocol registry | Global `fetch` to a fixed URL |
| `src/tools/email-send-tool.ts`, `src/tools/email-compose-tools.ts` | The user's SMTP server | `nodemailer`, outside every egress check; arguments only at dispatch |
| `src/tools/email-imap-session.ts` and the IMAP tools | The user's IMAP server | `imapflow`; reads, but the session holds the mailbox credential |

The in-process transport's own callers (twelve files, including web search,
image search, asset acquisition and skills install) get destination checks but
no payload judgment at send.

**G3. Three payload scanners, one of them partial.** The dispatch gate, the
browser scan and the kernel's own exfiltration heuristics each decide "does
this carry something sensitive" with different code. A fix in one does not
reach the others.

**G4. MCP servers on Windows run uncaged.** `src/mcp-client/connection.ts`
cages a server and points it at the proxy only when the posture is sandboxed,
which today means seatbelt or bwrap. On Windows the server process is spawned
with the host network and can dial anywhere.

**G5. HTTPS from a caged process is visible only as a host.** The shell and
sandboxed MCP servers reach the proxy by CONNECT, so their payloads are
encrypted end to end. The comment in `src/tools/shell-secret-env.ts` already
records this limit.

## Design

### One judge

A single pure function judges one outbound request:

```
judgeEgress({ sessionId, channel, url, method, headers, body, origin, approvals })
  -> { verdict: "allow" }
   | { verdict: "deny", evidence, canary: boolean }
   | { verdict: "ask", reason }
```

- `channel` names the enforcement point (tool transport, browser, proxy, mail).
- `body` is the bytes as sent: a string, a multipart body with its file parts,
  or `null` when the channel cannot see them (a CONNECT).
- `approvals` carries what the user already said yes to for this call: secret
  values approved for this destination by `src/secret-destination-gate.ts`,
  and a destination the user allowed. Placeholder secrets that `http_request`
  resolves on the wire are expected in the bytes and are not evidence.

It composes the primitives that exist: the destination policy
(`evaluateEgressForUrl`), the secret scanner
(`src/security/secrets/secret-scanner.ts`, raw and decoded views), taint overlap
(`findTaintInPayload` in data lineage), and the canary check
(`src/threat/canaries.ts`). The browser's `scanPageEgressWith` is the template:
it is already a per-request decision over injected session state, which is what
lets the egress worker run it against mirrored state. The judge generalizes it
to every channel, and the browser scan becomes a caller.

Home: `src/net/`, next to the proxy core, as `src/net/egress-judge.ts`. <!-- doc-paths:ignore -->
The module's owner row in `ARCHITECTURE.md` changes from "shell egress proxy" to
"network egress: the judge and its enforcement points", and the dispatch gate's
row points at it.

### Enforcement points

| Point | Sees | Judge input |
|---|---|---|
| In-process transport (`canonicalFetch`) | Full request, before TLS | URL, headers, body |
| Browser egress worker | URL and request body, before TLS | URL, body |
| Loopback proxy, plain HTTP | Full request | URL, headers, body |
| Loopback proxy, CONNECT | Host and port | Destination only |
| Mail send | The composed message, before SMTP's TLS | Envelope, headers, body, attachments |

The dispatch gate stays, because it runs before any side effect and is where
the user's approval card appears. It calls the same judge on the arguments, so
the early verdict and the send-time verdict cannot disagree on the same bytes.
The send-time judge never asks: a card mid-call has nowhere to render. It only
denies on evidence that the dispatch gate's approvals do not cover. In practice
it fires when a tool sent something the model never wrote.

### Session attribution at the proxy

The proxy authenticates every request with one token today
(`proxyAuthorizationHeader` in `src/net/egress-proxy-core.ts`). To judge taint,
it has to know which session a request belongs to. Each caged process gets
proxy credentials that name its session, issued when the shell or MCP server is
spawned and withdrawn when it exits. A request with unknown credentials is
refused, which is the behavior today.

## Migration order

Each phase ships alone, keeps the gate suite green, and runs both benchmarks.

1. **Extract the judge with no behavior change.** Done 2026-10-21:
   `src/net/egress-judge.ts` judges canary and taint for both channels, with
   each channel's taint reading (the floor for tool calls, positive overlap for
   pages) declared in one table, and session state injected so the browser's
   egress worker judges against its mirrors. The browser scan and the dispatch
   probes call it; their existing suites pin the verdicts and wording
   unchanged. The destination-aware secret scan stays in the dispatch gate
   until phase 3 gives it a second, send-time consumer; the browser's
   first-party exemption stays with the browser, as a destination rule.
2. **Close G2 by moving every direct caller onto the in-process transport.**
   Start with `src/tools/youtube-tool.ts`, the only one with no destination
   check at all. Then the local runtime calls in the image and video tools
   (loopback, through the transport's loopback branch), the connector proxy's
   local branch, and `src/protocols/marketplace.ts`. Then fold the inline
   transports in `src/tools/http-request-transport.ts` and `src/tools/web-fetch.ts`
   into `canonicalFetch`, so one transport remains.
3. **Judge at send in the transport (closes G1 for HTTP).** `canonicalFetch`
   calls the judge on the final URL, headers and body, multipart file parts
   included. Bodies over the scan cap (`SECRET_SCAN_CAP` in
   `src/data-lineage/paths.ts`) are judged on their head and on sampled
   fingerprint windows, and the cap is a test.
4. **Mail.** Judge the composed message in `src/tools/email-send-tool.ts` and
   `src/tools/email-compose-tools.ts` before it is handed to the SMTP library.
5. **Proxy.** Per-session proxy credentials; the judge on plain-HTTP requests;
   the destination-only judge on CONNECT.
6. **Windows MCP servers (G4).** Spawn them under the Windows cage with the
   proxy as their only route, as the POSIX path already does. This depends on
   the Windows cage supporting a long-lived process; until it does, the
   uncaged posture is shown in the MCP settings and named in the threat model.
7. **The structural guarantee.** A build test, in the style of
   `src/tools/tool-list-registry.test.ts`, parses `src/` and fails when a file
   outside a short registered list imports a network primitive (`fetch`,
   `undici`, `http`/`https`/`net`/`tls`/`dgram` sockets, a mail or database
   client). Each registered exception carries its reason. With this test,
   "everything goes through the judge" is enforced by the build instead of by
   review.
8. **Retire the duplicates.** The browser's scan state and the kernel's string
   exfiltration heuristics (entropy, alphabet, drip budget, in
   `packages/arikernel/runtime/src/run-state/exfil-detection.ts` and
   `packages/arikernel/runtime/src/run-state/egress-accounting.ts`) are deleted.
   The kernel keeps its policy table and audit chain and reads the judge's
   verdict.

## Outside the boundary, on purpose

The invariant test's exception list, and why each is not agent egress:

| Traffic | Why it is not judged |
|---|---|
| Model providers and adapters (`src/providers/`, the Anthropic and Codex clients, `src/llm-dispatch/`, the canonical-loop transports, embedding and reranker providers) | The conversation goes to the user's chosen model by design |
| Local runtimes and voice (`src/local-runtimes/`, `src/voice/`, the voice bridges) | Loopback to processes LAX starts |
| Account, phone and channels (`src/auth/`, `src/broker-transport/`, `src/telegram-bridge/api.ts`) | Fixed destinations the user configured; channel replies go to the user |
| Updates (`src/update-service.ts`, `src/ota-update.ts`) | The server's own fetch of its own releases |
| Self-tests and dev proxying (`src/doctor.ts`, `src/self-edit/`, `src/server/dev-server-proxy.ts`, the app-build smoke gates) | Loopback to the server or to a dev server the agent started |
| `src/mcp-bridge.ts`, `src/hooks/hook-engine.ts` | Loopback only, by code: the bridge calls this server's own API, and HTTP hooks refuse any non-localhost URL |

## What this does not stop

These go in the threat model next to the containment number.

- **HTTPS bytes from a caged process.** The shell and sandboxed MCP servers are
  judged on destination only. Seeing their payloads would mean intercepting
  TLS with a certificate authority installed on the user's machine. That
  changes the user's trust store, breaks programs that pin certificates, and
  puts a key that can impersonate every site on disk. It is rejected. The
  shell's other gates stay: the destination allowlist, the secret-env command
  judgment, and the OS cage.
- **Paraphrase.** Byte overlap does not survive rewording. Canaries and
  registered secret values do; a summary of a confidential document does not.
- **Side channels.** Request timing, response-driven behavior, and on an
  uncaged host, DNS.
- **What the user approves.** An approved destination receives what the call
  sends.

## Open questions

- Streaming request bodies (a large upload) cannot be judged after they start.
  Proposed: the transport buffers up to the scan cap and judges before the
  first byte leaves; larger bodies are judged on sampled windows.
- The proxy's per-session credentials need a lifetime tied to the process, so
  a crashed shell's credentials do not outlive it. Round 2's invariant 14 asks
  the same of credential projections, and they should share one mechanism.
