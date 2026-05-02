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
