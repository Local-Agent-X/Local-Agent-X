---
message: "switch provider to anthropic"
expect_tool_call: http_request
expect_url_contains: "/api/providers/switch"
expect_reply_match: "anthropic"
forbid_reply_match: "EXTERNAL_UNTRUSTED_CONTENT"
max_duration_ms: 30000
---

Verifies the provider-switch flow works end-to-end. Post-fix, the
endpoint aliases openai→codex when appropriate and auto-picks the best
model. Reply should acknowledge the switch in plain language.
