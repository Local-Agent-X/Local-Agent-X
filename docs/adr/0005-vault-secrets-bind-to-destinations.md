# ADR 0005 — A vault secret is bound to the destinations it may reach

Status: Accepted — 2026-10-13

## Context

The vault stores a secret by name with metadata (`service`, `account`, `url`,
`origin`). The only place that metadata gates anything is browser fill:
`browser_fill_from_secret` refuses a page whose origin is not the secret's
recorded origin, and a first use of a (secret, origin) pair needs the user's
approval unless this session captured the secret or the operation pre-blessed
it (`src/browser/secret-fill.ts`). Those approvals persist on the record as
`approvedFills`.

Every other way a secret leaves the machine has no such check. `http_request`
resolves `{{NAME}}` in headers and body for any host the model names, and a
cross-origin 307/308 re-sends the resolved body to the new host.
`connector_create` writes a manifest that binds a vault name to any upstream
the model chooses. `email_setup` sends the secret as an SMTP password to any
host the model picks, and remembers that host for every later send. The tool
descriptions and policy comments for all three claim origin limits, confirms,
or allow-lists that do not exist.

The 2026-10-13 audit found this as the one design gap behind a cluster of
false claims. A model that is tricked by a page or an email can be told
"send `{{STRIPE_KEY}}` to attacker.example" and the only thing in the way is
the model's judgment.

## Decision

A secret carries the set of destinations it may be sent to, and every channel
that emits a secret consults that set through one gate.

- **One record field.** `approvedFills` becomes `approvedDestinations`:
  `Array<{ origin: string; approvedAt: number }>`. The encrypted secrets file
  is read with a migration that renames the field; nothing else persists it
  (Agent Sync never carries `secrets.enc`).
- **One key.** A destination is an origin: `scheme://host[:port]`. HTTP and
  connector upstreams use the URL origin; mail uses `smtp://host:port` and
  `imap://host:port`. The normalization lives in one function in
  `src/secrets.ts` and is the only way a destination string is produced.
- **One gate.** `SecretsStore.destinationDecision(name, origin, ctx)` returns
  the same ladder the browser fill gate uses today, in the same order:
  recorded origin matches → allowed; same session captured it → allowed;
  operation pre-blessed it → allowed; user approved this pair → allowed;
  otherwise → ask. "Ask" raises the existing approval card (the one the fill
  gate raises), and a yes persists the pair.
  The session and pre-bless rungs are **site-conditioned**, as they are in
  the browser gate: they apply only when the secret has no recorded origin,
  or the destination is on the same site as the recorded origin. A secret
  captured from github.com this session may go to api.github.com without a
  card; it may not go to a host the model chose on another site.
- **Existing bindings carry over.** Connector manifests written before this
  gate existed bound a secret to an upstream with the user's knowledge. On
  the one-time migration of the secrets file to its new version, each
  manifest's (secret, upstream) pair is recorded as an approved destination,
  so nothing the user had already set up starts failing.
- **Reads consult it too.** `email_read` and the other IMAP readers run the
  gate for `imap://host:port` on every session open; a decision of "ask"
  there is a refusal that names `email_setup` as the place to approve the
  host, since a read tool has no approval card to raise.
- **Every emitter calls it.** `browser_fill_from_secret` (as today, through
  the shared ladder), `http_request` (the initial URL and every redirect hop
  that changes origin, before the body is re-sent), `connector_create` (the
  upstream at create time) and the connector proxy (at request time, so an
  edited manifest cannot widen a binding), `email_setup` (SMTP and IMAP hosts
  at setup, before the verify connection).
- **No overwrite from the model.** `SecretsStore.set` keeps upsert semantics
  for the user's paths (Settings, the modal, integration install). The model-
  facing writers create only: a name that exists is refused with the existing
  record's `service` and `account`, so the model can pick a distinct name.
  Two accounts on one platform are two records with the same `service` and
  different `account`; nothing about this design limits a platform to one
  secret. A secret replaced by the user keeps its approved destinations only
  when the recorded origin is unchanged.

## Consequences

- A secret used for the first time against a new host costs one approval
  card. A secret used where it was captured, or where the user already
  approved it, costs nothing. That is the same experience browser fill has
  had since 2026-07.
- `http_request` can no longer be used to send a key somewhere it has never
  been approved for, including through a redirect. Flows that legitimately
  reuse one key across hosts approve each host once.
- The descriptions of `list_secrets`, `request_secret`, `http_request`,
  `connector_create` and `email_setup` can say what the code does.
- The `/api/secrets/:name/approve-origin` route and the Settings modal keep
  working; they write the same field under its new name.

## Revisit when

A channel appears that emits a secret to something without an origin (a
local socket, a CLI subprocess). The gate's key would then need a second
shape, and that is the moment to decide whether such channels belong in the
vault's reach at all.

## Amendments

- 2026-10-21 — **The saved site or anything under it.** The origin rung
  allows a destination whose host is the recorded origin's host or a
  subdomain of it, with the same scheme and port (`isUnderOrigin` in
  `src/secret-destinations.ts`): a key saved for supabase.com may go to
  api.supabase.com. A neighbour (another project's host under the same
  parent), the parent itself, and anything under a public suffix are not
  under it. The browser credential fill asks the ladder for the exact origin
  (`exactOrigin`), so a password is still asked about on a look-alike
  subdomain page.
- 2026-10-21 — **A scheduled job's key plan.** A job may carry a plan
  (`CronJob.secretPlan`): the (key, site) pairs the user named for it, on
  the Missions page or on a card when the job was scheduled from the chat.
  The ladder's `planned` rung, after `approved`, allows a planned pair for
  the sessions of that job's runs and the agents and workers they spawn
  (`src/cron/job-secret-plan.ts`), and for no other session: a plan never
  writes the vault's approved destinations. Anything off the plan still
  ends in "ask", which an unattended run parks in the user's inbox.
