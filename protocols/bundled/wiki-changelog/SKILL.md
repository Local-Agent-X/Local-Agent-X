---
name: wiki-changelog
description: "Generate structured changelogs from git history. Use when user asks \"what changed recently\", \"generate a changelog\", \"summarize commits\" or user wants to understand recent development activity."
risk: unknown
source: community
date_added: "2026-02-27"
bundle_meta:
  source_repo: sickn33/antigravity-awesome-skills
  source_commit: e280b1f2aff20b08b830700b3891604a4efd63de
  source_license: MIT
  imported_at: 2026-04-26T17:06:55.456Z
  attribution: "Antigravity Awesome Skills (MIT, code; CC-BY-4.0, docs). Source: https://github.com/sickn33/antigravity-awesome-skills"
---
# Wiki Changelog

Generate structured changelogs from git history.

## When to Use
- User asks "what changed recently", "generate a changelog", "summarize commits"
- User wants to understand recent development activity

## Procedure

1. Examine git log (commits, dates, authors, messages)
2. Group by time period: daily (last 7 days), weekly (older)
3. Classify each commit: Features (🆕), Fixes (🐛), Refactoring (🔄), Docs (📝), Config (🔧), Dependencies (📦), Breaking (⚠️)
4. Generate concise user-facing descriptions using project terminology

## Constraints

- Focus on user-facing changes
- Merge related commits into coherent descriptions
- Use project terminology from README
- Highlight breaking changes prominently with migration notes

## When to Use
This skill is applicable to execute the workflow or actions described in the overview.
