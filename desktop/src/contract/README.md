# contract/ — the server↔desktop contract (generated, never hand-edit)

Every `.ts` file here is a copy of the same file in `src/desktop-contract/`, the
source of truth: the IPC messages, the environment variable names, the exit
codes, the data directory and its files, the pidfile and pid probe, the
loopback-URL rule, the rollback journal, the pre-build marker. The copy exists
because this directory compiles as CommonJS from `desktop/src` and cannot import
the server's ESM sources.

To change a contract, edit it under `src/desktop-contract/` and run

    node scripts/check-desktop-contract.mjs --sync

`npm run build` runs `check:desktop-contract`, which fails while a copy differs
from its source or has no source.
