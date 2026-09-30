# srt-win — the Windows shell network cage helper

Vendored from Anthropic's sandbox-runtime (`vendor/srt-win-src` at upstream
commit `3ed97390547bdd3d5cec5097d123f3a5fb741c6b`, Apache-2.0, see LICENSE).
Local Agent X builds this itself so the binary that provisions a machine-wide
sandbox account and firewall filters is signed by the same publisher as the
installer that ships it.

Build (Windows, MSVC toolchain):

```
cargo build --release --manifest-path packages/srt-win/Cargo.toml
```

`.cargo/config.toml` links the C runtime statically, so the helper runs on a
machine without the Visual C++ redistributable (upstream issue 451).

Local Agent X runs the helper under its own sublayer GUID and account name
(`lax-sandbox`, see `scripts/win-cage/provision.ps1`), so a machine that also
runs Anthropic's sandbox-runtime keeps both installs.

Changes against upstream, so the two products never share machine state:

- `src/user.rs`: account `lax-sandbox`, group `lax-sandbox-users`
  (upstream `srt-sandbox` / `sandbox-runtime-users`).
- `src/reg.rs`: install record under `HKLM\SOFTWARE\Local Agent X\shell-cage`
  (upstream `HKLM\SOFTWARE\sandbox-runtime`).
- `src/state_db.rs`: state and CA directory `%ProgramData%\Local Agent
  X\shell-cage` (upstream `%ProgramData%\sandbox-runtime`).
- `src/cert_store.rs`: the unit test's CA fixture lives at
  `tests/fixtures/tls-terminate/` (upstream keeps it at the repository root).
- `src/wfp.rs`: default sublayer `{6f3b9c1e-4a7d-4e52-9c0b-2d8e5f1a7b34}`
  (upstream `{2c5d0ad6-...}`).

Findings
from the escape matrix (`scripts/win-cage/escape-matrix.ps1`, run in CI on
every push) are in `docs/proposals/shell-sandbox-reuse-plan.md`, Step 5.
