# Shell egress at the network layer (P5 design)

Status: design only — approved direction from the 2026-07-23 security-vs-autonomy
audit (P5). Implementation is a follow-up /grand-daddy-brown campaign; nothing in
this doc is built yet. The interim string-layer egress rules stay in force until
the final phase here retires them.

## Problem

Shell egress control today is string parsing: argv0 classification, metachar
rules, and egress-binary approval tiers in `src/security/layer/shell-*.ts`. Four
adversarial rounds during the Jul 23 remediation confirmed this is whack-a-mole —
every rule has an encoding, wrapper, or interpreter bypass. The audit's verdict:
durable shell egress control belongs at the network layer (the OS stops the
packets), with string rules only as UX-level guidance on unconfined hosts.

## What already exists (reuse, don't fork)

- `src/browser/egress-proxy.ts` (~300 LOC): loopback HTTP/CONNECT proxy. Every
  request goes through `evaluateEgressForUrl` (the canonical egress policy —
  same gate the browser, http_request, and canary/taint layers use) and
  `resolveAndPinHost` (DNS resolution + pinning outside the requester, killing
  rebinding). It then dials the pinned address itself. This is the reusable
  core; the browser-specific part is only how Chromium is pointed at it.
- Sandbox modes (`src/sandbox/index.ts`): `docker` already runs
  `--network=none` — shell egress there is fully solved. `guarded` (default)
  cages credentials via seatbelt/bwrap but keeps network open. `seatbelt` /
  `bwrap` are the explicit strict modes. `host` has no OS enforcement.
- `buildSanitizedEnv` (shell env construction) — the injection point for proxy
  env vars.
- `sandboxDenialHint` — the pattern for mapping raw cage denials to truthful,
  recoverable agent-facing notices.

## Design

One invariant: **in a confined sandbox mode, the only route out of the cage is
the loopback egress proxy.** The cage denies direct outbound network at the OS
layer; the proxy applies the same canonical policy as every other egress path.

```
bash (caged) ── HTTP(S)_PROXY ──▶ loopback egress proxy ──▶ evaluateEgressForUrl
     │                                                        + resolveAndPinHost
     └── any direct dial / UDP / DNS ──▶ denied by seatbelt/bwrap/docker
```

Consequences that fall out for free:

- **DNS is no longer an exfil channel.** The proxy resolves names outside the
  cage; the cage denies all UDP including port 53. Tools using the proxy never
  need in-cage DNS.
- **Policy is uniform.** Shell traffic hits the identical allow/deny/canary/
  taint logic as browser and http_request traffic — one source of truth, and
  the trust-ledger /approve flow works unchanged for shell egress.
- **Fail closed.** A proxy-unaware tool (raw TCP, ssh) doesn't bypass anything;
  its connect() is refused by the cage.

### Per-mode enforcement

- **docker** — already `--network=none`. Optional later: attach the proxy via a
  unix socket mount if callers ever need sanctioned network in docker mode.
- **seatbelt (macOS)** — profile gains `(deny network*)` with a single allow for
  outbound TCP to `127.0.0.1:<proxyPort>` (and the self server port, which the
  proxy's policy already sanctions). seatbelt expresses this directly.
- **bwrap (Linux)** — `--unshare-net` creates an empty netns (already full
  deny). Reaching the loopback proxy from inside needs a bridge; options, in
  preference order: (1) pasta/slirp4netns forwarding only `<proxyPort>`,
  (2) a unix socket bind-mounted into the cage with a tiny in-repo forwarder to
  the proxy. Decide during implementation by what's installable/vendorable —
  start with plain `--unshare-net` (strict no-network, docker parity) so Linux
  ships the invariant first and gains sanctioned egress second.
- **guarded** — inherits whichever backend it selected (seatbelt or bwrap
  behavior above). Guarded stays the friendly default: network available, but
  only through policy.
- **host** — no OS enforcement possible; string layer remains, unchanged.

### Proxy-aware coverage

curl, wget, git-over-https, npm, pip, uv, brew, node fetch, and gh all honor
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`. `NO_PROXY` carries loopback + the self
server. Known non-proxy tools: ssh/scp/rsync-over-ssh (fail closed; the
truthful denial hint names the cage and points at `LAX_SANDBOX=host` or
Settings, mirroring the docker notice in shell-tool.ts). If soak shows real
ssh demand, a dedicated sanctioned tunnel is a separate decision — not smuggled
in here.

### Truthful failure surface

A blocked connect manifests as ECONNREFUSED (cage) or a proxy 403 with the
policy reason. Both must map to an agent-facing notice naming the real layer
and the recovery path (`sandboxDenialHint` sibling for network denials + the
proxy 403 body carrying `evaluateEgressForUrl`'s reason verbatim). No lying
messages — audit invariant.

## Campaign chunks (for the follow-up /grand-daddy-brown)

1. **Extract the proxy core** from `src/browser/egress-proxy.ts` into a shared
   module (e.g. `src/net/egress-proxy-core.ts`); browser keeps a thin adapter.
   Pure refactor, no behavior change, existing proxy tests must stay green.
2. **Shell proxy instance + env injection** — start (lazily) a shell-scoped
   proxy; `buildSanitizedEnv` injects proxy env vars in confined modes only.
   At this point traffic is *observable* through policy but not yet forced.
3. **Seatbelt network deny** — profile change + tests proving direct curl to an
   IP fails while proxied curl succeeds, and UDP/DNS is dead in-cage.
4. **bwrap `--unshare-net`** — strict parity on Linux; sanctioned-egress bridge
   (pasta or unix-socket forwarder) as its own follow-on chunk.
5. **Truthful denial mapping** — network-layer sibling of `sandboxDenialHint`,
   proxy 403 reasons surfaced verbatim, ledger audit events for denied dials.
6. **Stand down string-layer egress rules inside confined modes** — only after
   3/4 are live and a soak ledger shows the proxy path carrying real traffic
   with no silent breakage. Host mode keeps the string layer permanently.

Each chunk gets the standard treatment: canonical-check (extend the proxy, no
forks), blast-radius on `buildSanitizedEnv` and the seatbelt profile (both are
shared anchors), tests per chunk, 400-LOC gate.

## Risks / open questions

- **Tool breakage tail** — proxy-env coverage is broad but not total; chunk 2's
  observe-only phase plus soak ledgers measures the real tail before anything
  is forced (audit metric: friction <2% prompts, <0.5% denies).
- **HTTPS is opaque to the proxy** — CONNECT tunnels mean policy sees only
  host:port, not payload. That matches the browser proxy's contract already;
  payload-level canary/secret scanning stays at the existing layers. Not a
  regression, just not a new capability.
- **Proxy availability** — if the shell proxy fails to start in a confined
  mode, shell runs with cage-denied network and no sanctioned route: fail
  closed + loud notice, never fall back to open network (no-silent-fallback
  rule).
- **Windows** — no seatbelt/bwrap; docker mode or host-with-string-layer remain
  the Windows stories. Out of scope here.
