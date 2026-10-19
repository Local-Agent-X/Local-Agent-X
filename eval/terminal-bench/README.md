# Terminal-Bench with LAX

Runs LAX on [Terminal-Bench](https://www.tbench.ai/) through
[Harbor](https://github.com/harbor-framework/harbor), the runner the public
leaderboard uses. LAX is an *installed agent*, like Harbor's `claude-code` and
`codex`: it runs inside each task's container, so every harness works under
the same conditions and the task's own tests decide pass or fail.

| File | What it does |
|---|---|
| `lax_agent.py` | The Harbor agent (`lax_agent:LaxAgent`). Copies the bundle into the container and calls `drive.mjs`. |
| `drive.mjs` | Runs inside the container: boots a headless LAX on a fresh data dir with the task's working directory as the workspace, sends the instruction as one chat turn, waits, stops the server. |
| `seed.mjs` | The data dir each task starts from (provider and model, Autonomous profile, unrestricted file access inside the throwaway container). Tested by `test/terminal-bench-seed.test.ts`. |
| `bundle.mjs` | Builds the Linux bundle from one commit, entirely inside a Debian bullseye container: compiled `dist/`, production `node_modules` for linux-x64, and a Node binary. |

Nothing here changes product defaults. Each task gets its own empty data dir,
so nothing learned on one task reaches the next.

## Run it

Needs Docker (with NVIDIA GPU support for the GPU tasks) and Harbor
(`uv tool install harbor==0.24.0`).

1. Build the bundle from a commit (from the repo root):
   `node eval/terminal-bench/bundle.mjs --ref main`. It compiles inside
   Docker, so the checkout's own `dist/` and `node_modules` don't matter, and
   writes `~/.cache/lax-terminal-bench/lax-linux-x64.tgz` (`--out` changes that).
2. Local models: start LM Studio's server. Containers reach it at
   `http://host.docker.internal:1234`; Docker Desktop forwards that to the
   host's loopback, so LM Studio's default 127.0.0.1 binding works (checked
   on Windows, 2026-10-18). Another address goes in `LAX_TB_LOCAL_URL`.
3. Run, with this folder on `PYTHONPATH`:

   ```
   PYTHONPATH=eval/terminal-bench harbor run -d terminal-bench/terminal-bench@4.0.0 \
     -e docker -a lax_agent:LaxAgent -m lmstudio/qwen3.6-27b -n 1
   ```

   Add `-k 5` for leaderboard-grade attempts. Run one task at a time (`-n 1`)
   against one local model, since the model serves one request at a time.

Each trial's logs land under `/logs/agent/` in the trial folder:
`lax-result.json` (reply, tool calls, time), `lax-server.log`, `lax.txt`.

## Model names

| `-m` | LAX provider |
|---|---|
| `lmstudio/<model>`, `local/<model>` | `local`, reaching LM Studio (`host.docker.internal:1234`) through a hand-added runtime entry |
| `ollama/<model>` (e.g. `ollama/qwen3.6:27b`) | `local`, reaching Ollama (`host.docker.internal:11434`) the same way |

Subscription providers are not wired yet.

## Comparing harnesses

Compare harnesses on the same model and the same tasks. For a local model,
point every harness at the same server and the same model file. Codex runs
against Ollama (`-a codex -m openai/qwen3.6:27b` with
`OPENAI_BASE_URL=http://host.docker.internal:11434/v1` and any
`OPENAI_API_KEY`); against LM Studio its first request fails, because the
Qwen chat template LM Studio uses rejects a system message that is not the
first message, and Codex sends one mid-conversation. Through that API Codex
gets Ollama's default context window (64k on a 32 GB GPU); LAX sizes its own. Tasks that need the GPU compete with
a local model for VRAM; when they are skipped, skip them for every harness.
