---
name: Git Status Report
description: Show a clean summary of the current git state
allowed-tools: [bash]
when-to-use: When the user asks about recent changes, git status, or what's been modified
---

Run these git commands and present a clean summary:

1. Current branch name
2. Uncommitted changes (staged and unstaged) — list files only
3. Last 5 commits (one line each)
4. Any untracked files

Format as a clean report, not raw command output.
