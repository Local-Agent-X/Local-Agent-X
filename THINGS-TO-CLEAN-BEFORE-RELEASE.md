# Things to clean before release

Running list of cleanup tasks to handle before public/initial release. Add new entries to the bottom; mark done with a strikethrough or remove.

---

## Tracked files that should be untracked

### `packages/arikernel/runtime/audit.db` — done in 797f961

The AriKernel SQLite audit log was accidentally committed in `1de936a`, before the `*.db` rule existed in `.gitignore`. Once tracked, gitignore rules don't apply.

- It's runtime state — every session writes to it, generating merge churn and noise in `git status`.
- It contains local activity history — minor privacy leak when pushed.
- A fresh clone doesn't need it; `AuditStore` creates the schema on first write.

**Sweep before release:** scan the repo for any other accidentally-committed runtime artifacts already covered by `.gitignore` patterns. One-liner to find them:

```bash
git ls-files | while read f; do git check-ignore -q "$f" && echo "$f"; done
```

Anything that prints is tracked-but-ignored — candidate for `git rm --cached`.
