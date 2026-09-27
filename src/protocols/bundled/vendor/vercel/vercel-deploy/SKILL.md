---
name: vercel-deploy
description: Deploy a project to Vercel with the Vercel CLI and report the deployment URL. A preview deployment by default; production only when the user asks for production. Use for "deploy to vercel", "ship a preview", "put this on vercel".
triggers: [deploy to vercel, vercel deploy, preview deployment, ship to vercel, vercel production]
---
# Deploying with the Vercel CLI

Written for Local Agent X from Vercel's public CLI documentation (vercel.com/docs/cli). Vercel's own agent skills live at github.com/vercel-labs/agent-skills.

## Preconditions

- The CLI is installed: `vercel --version` prints a version. If it does not, `npx vercel …` runs it without a global install.
- The CLI is authenticated. `vercel whoami` prints the account name when it is — then go ahead; no token is needed. Only if it is not: use a Vercel token from the vault, handed to the command as an environment variable — bash `secret_env: { "VERCEL_TOKEN": "<SECRET_NAME>" }`. Never pass `--token <value>`: a token in the command line is visible in process lists and logs. If no token is stored, ask the user for one with `request_secrets` (they create it at vercel.com/account/tokens).
- The project is linked, or can be: a `.vercel/project.json` in the project root means it is. `vercel link --yes` links it non-interactively, answering setup questions with defaults inferred from `vercel.json` and the folder name.

## Steps

1. Run from the project's root directory, or pass `--cwd <path>`. Never run `vercel dev` for a deploy — that starts a local development server.
2. Preview deployment (the default, and the safe one): `vercel deploy --yes`. Add `--non-interactive` if anything prompts; under an agent the CLI usually defaults to it.
3. Production deployment, only when the user said production: `vercel deploy --prod --yes`. Note that the very first deployment of a new project is always a production deployment, even without `--prod` — say so if that is what happened.
4. Read the result: **stdout is the deployment URL.** A non-zero exit code means the deployment failed; the reason is on stderr. Report the URL exactly as printed. If no URL was printed, the deployment did not happen — say that, do not invent one.

## Useful options

- `--env KEY=value` / `--build-env KEY=value` — runtime and build-time variables for this deployment.
- `--prebuilt` — deploy a `vercel build` output. System environment variables are missing at build time with it, so avoid it for frameworks that read them while building.
- `--archive=tgz` — for projects with thousands of files, to stay under upload limits.
- `--logs` — also print the build logs. `--force` — rebuild without the build cache.
- `--scope <team>` or `--team <slug>` — deploy under a team other than the active one.

## When a step fails

The CLI changes over time and this skill is pinned to the day it was written. If a flag is rejected or a step does not behave as described, run `vercel <command> --help` first — it always matches the installed version — then check vercel.com/docs/cli before retrying, and tell the user what you changed and why.
