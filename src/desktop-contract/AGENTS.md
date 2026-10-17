# desktop-contract

**Owns:** Everything the server (`src/`, ESM) and the Electron main process (`desktop/src/`, CJS) must agree on without importing each other: the IPC messages (`ipc.ts`, `browser-bridge.ts`), the environment variable names (`env.ts`), the exit codes (`exit-codes.ts`), the data directory and the files in it (`data-dir.ts`), the pidfile and the pid probe (`pidfile.ts`, `pid-probe.ts`), the loopback-URL rule the app probe enforces on both ends (`loopback-app-url.ts`), the update-rollback journal shape and validator (`rollback-journal.ts`), the pre-build marker (`prebuild-marker.ts`).
**Does not own:** Either side's behaviour. The server's bridge client is `src/desktop-bridge.ts` and `src/browser/bridge-client.ts`; main's handlers are `desktop/src/server-bridge.ts` and `desktop/src/server-bridge-browser.ts`.
**Entry:** Each file is imported directly; there is no barrel. The desktop imports the generated copy in `desktop/src/contract/`.

## Invariants
- Every file here is a pure leaf: Node built-ins and sibling contract files only, imported with the `.js` suffix. It compiles unchanged under both tsconfigs (ESM Node16 here, CommonJS in `desktop/`).
- `desktop/src/contract/` is generated from this folder by `scripts/check-desktop-contract.mjs --sync` and never hand-edited; `npm run build` (`check:desktop-contract`) fails while a copy differs.
- A message type, env name or exit code either side keys on is declared here; `test/desktop-server-contract.test.ts` scans both sides for literals outside these sets.
- `laxDataDir()` is the one data-dir resolver on both sides (`LAX_DATA_DIR`, else `~/.lax`); the managed Node runtime (`managedRuntimeDir()`) is an install location and stays under `~/.lax` regardless.

## Coupled to
| If you change | Also check | Guard |
|---|---|---|
| any file here | `desktop/src/contract/` (run `--sync`) | `check:desktop-contract` |
| `SERVER_TO_MAIN_TYPES` / `MAIN_TO_SERVER_TYPES` / `BROWSER_*_TYPES` | the sender and the handler switch on each side | `test/desktop-server-contract.test.ts` |
| `DESKTOP_ENV` | `desktop/src/server-process.ts` (sets), the server modules that read each name | `test/desktop-server-contract.test.ts` |
| `validJournal` | `src/update-rollback.ts`, `desktop/src/rollback-journal-heal.ts` | `src/update-rollback.test.ts`, `desktop/src/rollback-journal-heal.test.ts` |
| `managedRuntimeDir()` | `RUNTIME_NODE_PATH_AUGMENTS` in `scripts/installer/process-tools.mjs` | `test/native-node-path-parity.test.ts` |

## Tests
`npx vitest run src/desktop-contract test/desktop-server-contract.test.ts` (PowerShell on Windows)
