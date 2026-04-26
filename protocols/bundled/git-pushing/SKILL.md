---
name: git-pushing
description: "Stage all changes, create a conventional commit, and push to the remote branch. Use when explicitly asks to push changes (\"push this\", \"commit and push\"), mentions saving work to remote (\"save to github\", \"push to remote\"), or completes a feature and wants to share it."
risk: critical
source: community
date_added: "2026-02-27"
bundle_meta:
  source_repo: sickn33/antigravity-awesome-skills
  source_commit: e280b1f2aff20b08b830700b3891604a4efd63de
  source_license: MIT
  imported_at: 2026-04-26T17:06:53.002Z
  attribution: "Antigravity Awesome Skills (MIT, code; CC-BY-4.0, docs). Source: https://github.com/sickn33/antigravity-awesome-skills"
---
# Git Push Workflow

Stage all changes, create a conventional commit, and push to the remote branch.

## When to Use
Automatically activate when the user:

- Explicitly asks to push changes ("push this", "commit and push")
- Mentions saving work to remote ("save to github", "push to remote")
- Completes a feature and wants to share it
- Says phrases like "let's push this up" or "commit these changes"

## Workflow

**ALWAYS use the script** - do NOT use manual git commands:

```bash
bash skills/git-pushing/scripts/smart_commit.sh
```

With custom message:

```bash
bash skills/git-pushing/scripts/smart_commit.sh "feat: add feature"
```

Script handles: staging, conventional commit message, Claude footer, push with -u flag.

## Limitations
- Use this skill only when the task clearly matches the scope described above.
- Do not treat the output as a substitute for environment-specific validation, testing, or expert review.
- Stop and ask for clarification if required inputs, permissions, safety boundaries, or success criteria are missing.
