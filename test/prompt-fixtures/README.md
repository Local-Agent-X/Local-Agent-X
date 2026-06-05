# Prompt Regression Fixtures

Golden-path interaction tests. Run after any system-prompt change to catch
behavior regressions before they bite in production.

## Usage

Start the LAX server, then:

```
node scripts/run-prompt-fixtures.mjs
```

This sends each `*.md` fixture here through the live chat API (as a fresh
session), captures the response, and checks for the declared invariants.

Exit code 0 = all passed. Exit code 1 = regression detected.

## Fixture file format

Each `*.md` fixture has YAML frontmatter + markdown body:

```markdown
---
message: "change app to dark mode"
provider: codex             # optional — defaults to whatever's currently selected
model: gpt-5.4              # optional
expect_tool_call: http_request
expect_url_contains: "/api/settings"
expect_reply_match: "dark"
forbid_reply_match: "EXTERNAL_UNTRUSTED_CONTENT"
timeout_seconds: 20
---

(freeform notes — what this fixture is testing and why)
```

Supported checks (all optional, all combine with AND):

- `expect_tool_call: <name>` — assistant must emit a tool_call with this name somewhere in the turn
- `expect_url_contains: <substr>` — the matched tool call's arguments must contain this substring
- `expect_reply_match: <substr>` — final assistant text must include this
- `forbid_reply_match: <substr>` — final assistant text must NOT include this (useful for `<<<EXTERNAL_UNTRUSTED_CONTENT`, `[called X]`, `{"tool_calls"` leakage)
- `max_tokens: <n>` — turn's completion tokens cap
- `max_duration_ms: <n>` — wall-clock cap

## When to run

- Before pushing prompt changes (commit hook candidate)
- After a prompt edit to confirm nothing regressed
- Weekly, as a sanity baseline across providers

## Not a unit test

These run against the live LLM through the live server. They can be flaky
on edge cases because LLMs are non-deterministic. If a fixture fails,
don't auto-accept — look at why. If the model is taking a reasonable but
different path, either loosen the check or accept the new golden path.
