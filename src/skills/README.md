# Skills (upstream-pattern bundle directory)

Each subdirectory is a self-describing **skill bundle** — a tool plus
its when-to-use guidance, provider-specific config, and policy in one
self-contained folder. Pattern stolen from upstream's
`.agents/skills/<name>/{SKILL.md, agents/<provider>.yaml}`.

## Bundle contract

```
src/skills/<name>/
  SKILL.md         — YAML frontmatter (name, description) + markdown body
                     describing when to use this skill, examples, gotchas.
                     Read by the agent at boot to populate tool guidance.
  tool.ts          — TypeScript implementation (the ToolDefinition).
                     Imported by the registry discoverer.
  policy.json      — (optional) per-skill policy overrides:
                     allowed-providers, sandbox requirements, rate limits,
                     auto-approve rules, etc.
```

## Why bundles instead of a flat registry

Today SAX's tools live in `src/tools/{file-tools, web-tools, ...}.ts` with
guidance scattered across `tool-prompt-builder.ts`, `tool-policy.ts`, and
`tool-filter.ts`. Adding a new tool requires editing 4 files. A bundle
collapses all 4 edits into one new folder.

Long-term, every tool in `src/tools/` migrates here. Today this directory
is a **pattern beachhead** — one or two example skills exist, and the
registry knows how to discover them. New tools should ship as bundles
from day one; legacy tools migrate as they're touched.

## Discovery

`src/skills/discover.ts` walks this directory at boot, reads each
`SKILL.md`, imports each `tool.ts`, and returns an array of
`ToolDefinition` ready to register. The result is folded into
`src/tools/registry-build.ts` `allTools` so callers see no difference.

## Default skill set is intentionally minimal

The base install ships only the curated typed protocols in
`src/protocols/packs/*.ts` plus the `example/` skill in this directory —
roughly fifteen high-signal entries. We deliberately do not ship a giant
generic skill catalog: large bundled libraries dilute search, blow up
boot work, and most entries are irrelevant to any one user.

Users who want more can layer them in:

- **Optional skill packs** — drop a curated SKILL.md pack into
  `protocols/bundled/` (or run `scripts/import-protocols.mjs` against a
  source list). The bundled loader picks them up automatically.
- **User-specific skills** — write SKILL.md files into
  `~/.lax/protocols/imported/<name>/` or typed records into
  `~/.lax/custom-protocols.json`. These override anything bundled or
  built-in on name collision.

If you find yourself reaching for the same skill across projects, promote
it to a pack repo rather than re-adding it to this default tree.
