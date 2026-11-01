# Retrofit: audit an existing repo

An existing repo already has conventions, a size limit, and docs people rely on.
Audit first, report a ranked gap list, and change nothing until the user picks
what to fix. Never overwrite existing guidance docs with templates. Fold the
template's missing pieces into them.

## Step 1 — Learn the repo's existing rules

- Read every guidance file: root and nested `AGENTS.md`, `CLAUDE.md`, `README.md`,
  `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/adr/`.
- Find the existing size ceiling (hygiene scripts, lint config, AGENTS.md). The
  kit counts CODE lines (comments and blank lines are free), so a repo's
  physical-line ceiling does not carry over one to one: measure first
  (`check-code-size.mjs` prints the warning band) and pick caps the user agrees
  to, usually lower than the old physical-line number. Never raise a cap to
  make the check pass.
- Find the build/test/check commands and any existing generated docs or guard
  tests. Extend those rather than adding parallel ones.

## Step 2 — Run the bundled scripts in report mode

Run them from the repo root, writing output to a scratch location. Don't touch the repo yet.

```bash
node <skill>/scripts/codebase-map.mjs --root <src> --max-code <cap> --warn-code <warn> --out <scratch>/map.md [--entry <dir> ...]
node <skill>/scripts/check-code-size.mjs --root <src> --max-code <cap> --warn-code <warn> --max-fn <fn cap> --warn-fn <fn warn>
node <skill>/scripts/check-doc-paths.mjs                 # all live docs
node <skill>/scripts/check-doc-paths.mjs AGENTS.md ARCHITECTURE.md <nested guides>   # guidance only
node <skill>/scripts/check-module-owners.mjs --root <src>   # modules nobody wrote down
node <skill>/scripts/code-refs.mjs --duplicates            # TS/JS: exported names declared twice
node <skill>/scripts/check-canonical.mjs --root <src> ... --canonical <shared root>   # several roots: one job written twice
```

The map's "Module cycles" section, `--duplicates` and check-canonical are where
parallel implementations show up: two modules that each claim the same job
usually share a name, or reach each other. `--duplicates` reads one TypeScript
project; check-canonical compares source roots, which is where a monorepo
drifts (web and mobile each writing the same service, an app re-declaring the
shared package's types).

If the repo already has its own map generator, compare totals with it. A
mismatch is a finding about one of the two generators.

## Step 3 — Find the gaps

For each item, collect evidence with `file:line`:

1. **Contradictions between guidance files.** The same topic gets different
   instructions in two files, e.g. root says "never edit X" while a nested guide
   says "add a row to X". These are the most damaging finding, because an agent
   obeys whichever file it read last.
2. **Stale claims.** Missing paths from check-doc-paths. Gitignored misses get a
   manual look: a deleted module can be gitignored too. Also compare each
   guidance doc's last-commit date (`git log -1 --format=%cs -- <doc>`) with
   churn in the code it describes.
3. **Prose coupling.** Run the grep in `registry-pattern.md`. Each "also update X"
   is an unenforced coupling and becomes a test.
4. **Unowned modules and second owners.** Every module check-module-owners lists,
   and every pair of modules claiming the same job (`--duplicates` hits,
   check-canonical findings, its "mirrors X" comments, two headers that both say
   "the single owner of X"). The second kind is the one
   agents created; it gets a consolidation, not a doc row.
5. **Runtime couplings.** Inventory the kinds in `couplings.md` the import graph
   can't see: event names, shared metadata keys, persisted formats, text parsed
   back out of text, cross-process protocols. Record producers, consumers and
   the current guard for each; unguarded silent ones rank first.
6. **Unsealed hubs.** Modules with many outside importers (from the map) and no
   seal test. These are where deep imports spread.
7. **Flat namespace.** Loose files at the source root that cluster by prefix
   (`approval-*.ts`, `config-*.ts`). A folder is an ownership signal.
   `ls <src> | sed -E 's/[-_.].*//' | sort | uniq -c | sort -rn | head`
8. **No reach tooling.** Nothing answers "what does this change reach, and
   which tests cover it" past one hop, and agents grep for symbols by habit.
   The fix is `--depth` on deps/refs and, for TS/JS, the refs hint hook.
9. **History mixed with live docs.** Campaign logs, PRDs and design docs for
   shipped work that sit in `docs/`, usually the bulk of the stale-path hits.
10. **Decisions outside the repo.** Rulings that live only in the user's notes,
   chat history or agent memory. List them as ADR candidates. Ask before
   copying anything from private notes into the repo.

## Step 4 — Report

```markdown
# AI-navigability audit — <repo> (<date>)

## Verdict
<two sentences: what's already strong, what causes the whack-a-mole>

## Gaps (ranked by damage × ease)
| # | Gap | Evidence | Fix | Effort |
|---|---|---|---|---|
| 1 | <contradiction> | `src/AGENTS.md:31` vs `AGENTS.md:84` | <edit> | S |

## Already in place (keep)
- <existing generator / seal tests / checks>

## Proposed sequence
<chunks, each independently shippable, with what verifies it>
```

Rank contradictions and stale guidance first: they're cheap and they actively
mislead. Coupling tests and seals come next: they stop the whack-a-mole. Folder
moves come last: they touch many imports for a smaller gain.

## Step 5 — Implement only what the user picks

Hand multi-chunk work to `/brownfield` (or `/grand-daddy-brown` for a long
campaign), one gap per chunk, with the repo's full build after each. Adopting
the size check on a repo with existing violators means seeding the ratchet once
(`--write-ratchet`: every file and function over a cap, at its size, sorted, so
the same tree always writes the same file). After that an entry may only
shrink (`--tighten` locks a shrink in and drops what is back under the cap).
Never raise a cap or re-seed the ratchet to make the check pass. Adopting
check-canonical is the same: `--write-ratchet` once, a `# note` on each pair that
must exist (each app's own client), and the rest is debt that only goes down.
