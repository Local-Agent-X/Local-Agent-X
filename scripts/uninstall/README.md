# Removing Local Agent X

These two scripts are the **only** implementation of "remove Local Agent X".
The Windows Settings entry, the macOS `Uninstall Local Agent X.command` shim,
the NSIS uninstaller's cleanup hook and `npm run uninstall` all call one of
them, so there is nothing that can drift out of sync with the others.

They are deliberately self-contained: **no Node, no npm, no repo checkout, no
working Local Agent X install, and no working update system are required.**
That constraint is the point. A user whose install is broken cannot receive a
fix through the updater, so the way out must not depend on any of it.

## The normal way

**Windows** — Settings → Apps → Installed apps → Local Agent X → Uninstall.

**macOS** — double-click `Uninstall Local Agent X.command` next to the app in
Applications.

Both keep your data (chats, memory, saved API keys) in `~/.lax` so a reinstall
picks up where you left off.

## If the Settings entry does nothing

This happens on installs made before the self-healing registration landed: the
entry pointed at a script inside the source tree, and a rolling update replaced
that tree and deleted it. Windows then ran a missing file, which exits
instantly with nothing to show. Run the script directly instead.

Every install made after that fix stages a copy here, which survives updates:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.lax\uninstall\lax-uninstall.ps1"
```

```bash
bash ~/.lax/uninstall/lax-uninstall.sh
```

If that file does not exist either, fetch the script and run it:

```powershell
irm https://raw.githubusercontent.com/Local-Agent-X/Local-Agent-X/main/scripts/uninstall/lax-uninstall.ps1 -OutFile "$env:TEMP\lax-uninstall.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\lax-uninstall.ps1"
```

```bash
curl -fsSL https://raw.githubusercontent.com/Local-Agent-X/Local-Agent-X/main/scripts/uninstall/lax-uninstall.sh -o /tmp/lax-uninstall.sh
bash /tmp/lax-uninstall.sh
```

From a checkout: `npm run uninstall` (add `-- --dry-run` to preview).

## Options

| Windows | macOS / Linux | Effect |
| --- | --- | --- |
| *(none)* | *(none)* | Ask before removing; ask whether to delete data |
| `-DryRun` | `--dry-run` | Print what would be removed, change nothing |
| `-Yes` | `--yes` | No prompts. Removes the app, **keeps** your data |
| `-Yes -DeleteData` | `--yes --delete-data` | No prompts. Removes the app **and permanently deletes** `~/.lax` |

## What gets removed

Discovered, not hardcoded — so every historical install shape is cleaned up,
including a machine that has been through several of them:

- the source tree (`%LOCALAPPDATA%\Local Agent X`, or wherever
  `~/.lax/config.json`'s `projectRoot` points)
- the packaged shell (`%LOCALAPPDATA%\Programs\local-agent-x-desktop`,
  `/Applications/Local Agent X.app`)
- Electron user data, including the legacy `electron` folder
- Desktop and Start Menu shortcuts
- **every** matching Add/Remove Programs entry, not just one

`~/.lax` is kept unless you explicitly ask for it to be deleted. When it is
kept, the stale `projectRoot` pointer is cleared so a reinstall cannot bind to
a directory that no longer exists.

## What is deliberately never removed

- **Any directory containing `.git`.** That is a working copy, not an install
  artifact, and it may hold uncommitted work. A developer whose `projectRoot`
  points at their own clone gets the clone back untouched.
- Directories that fail the source-tree sentinel check, so a mis-set
  `projectRoot` cannot turn this into a generic directory shredder.
- Paths that resolve to a home or system root, or that are suspiciously short.
- Ollama and any models you downloaded — those are separate software.

Anything skipped for these reasons is listed in the final report rather than
passed over in silence.
