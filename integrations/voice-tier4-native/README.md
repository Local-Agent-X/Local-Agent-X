# Tier 4 native voice — MOVED

The runtime code now lives in **`src/voice/tier4/`** so it ships in `dist/`
when you run `npm run build` (the integrations folder is outside `tsc`'s
`rootDir: "src"`).

The files in this directory are kept temporarily as a reference but are NOT
imported by the orchestrator or smoke test. Delete this folder after one
release cycle.

See:

- `src/voice/tier4/README.md` for the new home.
- `docs/voice-tier4-status.md` for ship status, latency numbers, and gaps.
- `scripts/test-tier4-smoke.mjs` for the end-to-end smoke test.
