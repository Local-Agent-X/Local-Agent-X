---
name: ddd-tactical-patterns
description: "Apply DDD tactical patterns in code using entities, value objects, aggregates, repositories, and domain events with explicit invariants."
risk: safe
source: self
tags: "[ddd, tactical, aggregates, value-objects, domain-events]"
date_added: "2026-02-27"
bundle_meta:
  source_repo: sickn33/antigravity-awesome-skills
  source_commit: e280b1f2aff20b08b830700b3891604a4efd63de
  source_license: MIT
  imported_at: 2026-04-26T17:06:52.621Z
  attribution: "Antigravity Awesome Skills (MIT, code; CC-BY-4.0, docs). Source: https://github.com/sickn33/antigravity-awesome-skills"
---
# DDD Tactical Patterns

## Use this skill when

- Translating domain rules into code structures.
- Designing aggregate boundaries and invariants.
- Refactoring an anemic model into behavior-rich domain objects.
- Defining repository contracts and domain event boundaries.

## Do not use this skill when

- You are still defining strategic boundaries.
- The task is only API documentation or UI layout.
- Full DDD complexity is not justified.

## Instructions

1. Identify invariants first and design aggregates around them.
2. Model immutable value objects for validated concepts.
3. Keep domain behavior in domain objects, not controllers.
4. Emit domain events for meaningful state transitions.
5. Keep repositories at aggregate root boundaries.

If detailed checklists are needed, open `references/tactical-checklist.md`.

## Example

```typescript
class Order {
  private status: "draft" | "submitted" = "draft";

  submit(itemsCount: number): void {
    if (itemsCount === 0) throw new Error("Order cannot be submitted empty");
    if (this.status !== "draft") throw new Error("Order already submitted");
    this.status = "submitted";
  }
}
```

## Limitations

- This skill does not define deployment architecture.
- It does not choose databases or transport protocols.
- It should be paired with testing patterns for invariant coverage.
