---
message: "what is 7 times 8"
forbid_reply_match: "sidebar"
forbid_reply_match_2: "/api/sidebar/pins"
forbid_reply_match_3: "mario"
expect_reply_match: "56"
max_duration_ms: 15000
---

Guards the "when stuck, pivot to something I remember from memory"
regression. User asks a trivial arithmetic question — agent should
answer with 56 and stop. It should NOT pin anything, NOT ls the
workspace, NOT touch memory-remembered topics (Mario, pins, recent
activity).

This fixture will catch cases where memory context pollutes the
reply on trivial queries.
