---
name: example_skill
description: "Reference skill bundle showing the upstream pattern. Returns a ping/pong used by the discoverer to validate the loader works end-to-end. Real skills will replace this once legacy tools migrate."
---

# Example skill

This is a **reference bundle** for the skill-discovery system. It exists
to validate that:

1. `src/skills/discover.ts` walks this directory at boot
2. Reads this `SKILL.md` for the name + description
3. Imports the `tool.ts` (compiled to `tool.js`) and gets a working
   `ToolDefinition` back
4. Folds it into the registered tool set

## When to use

Never. This is wiring proof, not a real capability. Real skill bundles
will replace it. Calling `example_skill` returns `{ ok: true, ping:
"pong" }` and nothing else.

## Bundle contents

```
src/skills/example/
  SKILL.md     ← this file
  tool.ts      ← exports the ToolDefinition (default export)
```

## Migration note

Once the first real tool (e.g. `memory_search` or `web_fetch`) migrates
from `src/tools/` to a bundle here, this example folder can be deleted.
