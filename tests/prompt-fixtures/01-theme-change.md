---
message: "change app to dark mode"
expect_tool_call: http_request
expect_url_contains: "/api/settings"
expect_reply_match: "dark"
forbid_reply_match: "EXTERNAL_UNTRUSTED_CONTENT"
max_duration_ms: 30000
---

Simplest bellwether. If this regresses, something fundamental broke:
- tool catalog wiring
- http_request availability
- model's intent → endpoint mapping
- workspace-vs-public file routing (shouldn't even come up here)

The `forbid_reply_match` catches the prompt-echo regression where
Anthropic agents paste raw EXTERNAL_UNTRUSTED_CONTENT blocks into replies.
