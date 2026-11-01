# Couplings: classify them, then give each kind its check

The import graph shows one kind of coupling. Most silent breakage comes from
the others: two modules that share an event name, a metadata key, a file
format or a string one writes and another parses, with no import between
them. Change one side and nothing fails until the feature is wrong.

The rule is the same for every kind: **declare the shared thing once, make
both sides use that declaration, and add a test that fails when a side
drifts.** What differs is where the declaration lives and what the test checks.

## Step 1 — Classify

At setup (or in a retrofit audit), find which kinds the project actually has.
Install the checks for those kinds only. A project with no event bus doesn't
get an event checker.

| Kind | How to spot it | Present? |
|---|---|---|
| 1. Imports | always | yes |
| 2. N-table registries | the same name listed in several files: tools, routes, permissions, providers, flags | |
| 3. Events and messages | `emit("...")`, `on("...")`, WebSocket/SSE/IPC message `type` strings, a bus | |
| 4. Keys in shared bags | `metadata.x`, `ctx.x`, `args._x` read by a module that didn't set them | |
| 5. Persisted formats | a file, row, log or payload written by one module and read by another (or by a later version) | |
| 6. Text parsed back out of text | a header, marker or prefix rendered in one place and regex-matched in another | |
| 7. Cross-process / cross-repo protocols | client and server, app and companion app, two repos sharing a message shape | |
| 8. Runtime lookups | `import(variable)`, string-keyed loaders, plugin hooks, config keys looked up by name | |

Search hints: `grep -rnE "emit\(|\.on\(|type: \"" src`, `grep -rnE "metadata\.[a-z_]+|\[\"[a-z_]+\"\]" src`,
and the prose-coupling grep in `registry-pattern.md`.

## Step 2 — One home and one test per kind

| Kind | The one declaration | The test |
|---|---|---|
| 1. Imports | the generated codebase map; seal rows and forbidden-dependency rules in the seal test | map freshness (`--check`), seal test, forbidden-dependency test |
| 2. Registries | a single `define*` declaration every table derives from | see `registry-pattern.md` (type-level completeness, or a test over every table) |
| 3. Events | a typed union or name→payload map (`events.ts`) both producer and consumer import | every emitted name is declared; every declared name has a consumer, or is marked as UI-only |
| 4. Shared-bag keys | a typed interface for the bag, with the keys as named constants | no string-literal key for the bag outside its declaration (a source scan), or reads go through accessors |
| 5. Persisted formats | one module that owns both the reader and the writer, with a version field | round-trip test plus a fixture of every older version the reader still accepts |
| 6. Text parsed back | the module that renders the text also exports its parser (a render/parse pair) | round-trip test; nobody outside that module matches the text by prefix or regex |
| 7. Protocols | one shared package, vendored into each side with a sync check, or a schema both validate against | the sync check, plus a contract test on each side |
| 8. Runtime lookups | the list of keys a loader accepts | every key resolves to a real module or handler; runtime-loaded modules marked `--entry` in the map |

Write the result into AGENTS.md's coupling section: each kind present, its
home, its guard test. A coupling with no guard is listed too, as debt.

## Why kind 6 deserves the extra care

Text parsed back out of text is the quietest kind. A route that decides a call
failed by checking whether the output starts with `BLOCKED` keeps compiling
and keeps passing its own tests after the renderer starts writing a status
header first; it just reports every refusal as a success. A prompt that
inlines a rules file couples that file's wording to anything that regex-reads
the prompt. When a parser and its renderer live in different modules, they
will drift.

## Retrofit

In an existing repo, do the classification as an inventory: for each coupling
found, record the shared key, every producer and consumer (`file:line`), the
current guard (test name, or none), and whether a drift fails loudly or
silently. Rank by silent × number of sides × unguarded, and report before
changing anything.
