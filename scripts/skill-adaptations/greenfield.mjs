// The owner's /greenfield skill as LAX ships it: literal phrase swaps, applied by
// scripts/check-skill-sync.mjs to SKILL.md and to its references. Each `from` must
// still be in the skill word for word, or --sync fails and names it.
//
// What changes, and why:
// - The suite is sealed by LAX's security layer (src/security/layer/holdout-seal.ts),
//   not a Claude Code hook and judge agent: holdout_write / holdout_seal write it by
//   project name, holdout_judge scores the running app against it, and no new
//   session is needed for the seal to hold.
// - The waves run on LAX's build engine, run_build_plan, which reads the plan in
//   its own chunk format (src/auto-build/plan-parser.ts) and starts the app from
//   `.lax-launch.json`, so scenario files are numbered for the plan to cite.
// - The structure kit is written by project_kit; /new-project's templates are read
//   with the protocol tool.
// - Skills LAX does not bundle (/grand-daddy-*, /dry-audit, /security-review,
//   /design-pass, ...) become a reviewer agent with the gate's own brief.

export const GREENFIELD = [
  ["(sealed by a hook, not a request)",
   "(sealed by LAX itself, not by a request)"],
  ["Combines /app-build, /grand-daddy-green and the new-repo half of /new-project; prefer it over those for any new build. Not for changing an existing codebase (/brownfield, /grand-daddy-brown) or",
   "Includes the new-repo half of /new-project. Not for changing an existing codebase (/brownfield) or"],
  ["  kept outside the repo and sealed by a hook. A separate judge scores the",
   "  kept outside the repo and sealed by LAX itself. A separate judge scores the"],
  ["├── scripts/              the structure checks and the holdout guard\n└── .claude/              the guard hook and the judge agent\n\n~/.holdout/<project>/     the sealed scenario suite, outside the repo",
   "├── scripts/              the structure checks\n└── .lax-launch.json      how the judge starts the app\n\nthe sealed scenario suite: kept by LAX outside the project (holdout_write)"],
  ["Create the project folder and `git init` it, so `spec/` has history from its\nfirst file.",
   "Create the project folder, `workspace/apps/<name>` (served, so it opens on\nthe phone), and `git init` it, so `spec/` has history from its first file."],
  ["Write the acceptance scenarios from the spec, in plain prose, into\n`~/.holdout/<project>/`. Show them to the owner. Record the index (file names\nand what each covers, nothing more) in `spec/ledger.md`. Then seal the suite:\ninstall the guard hook and the judge agent, and prove the wall by having a\nthrowaway agent try to read the suite and be refused.",
   "Write the acceptance scenarios from the spec, in plain prose, one\n`holdout_write` call each. Show them to the owner. Record the index (file names\nand what each covers, nothing more) in `spec/ledger.md`. Then seal the suite\nwith `holdout_seal`, and prove the wall by having a throwaway agent try to read\nthe suite and be refused."],
  ["Sealing usually ends the session: a hook and an agent added mid-session are\noften not live until a new one starts. If the probe is not refused, write the\nresume point to the ledger, ask the owner to open a new session in the project\nand say \"resume the greenfield build\", and stop there.\n\n",
   "The seal is live the moment `holdout_seal` returns; no new session is needed.\nIf the probe is not refused, stop and tell the owner: the wall is broken.\n\n"],
  ["One owner, serial, in both modes: create the repo, copy in the structure kit,",
   "One owner, serial, in both modes: create the repo, add the structure kit (`project_kit`),"],
  ["1. Hand a builder the chunk, the spec sections it covers, the constitution and\n   `spec/design.md`. It builds from `spec/` only.\n2. Match the discipline to the kind. A `trunk` chunk (auth, the data layer,\n   anything other code depends on) gets `/senior-engineer`: root cause,\n   smallest correct change, and you read the diff. A `leaf` chunk (a screen, an\n   isolated feature, glue) gets `/vibe-code`: verify by behavior, do not read\n   every line. Do not vibe a payments integration; do not senior-engineer a\n   button color.\n3. Run `check`. Start the app and have the judge run the chunk's scenarios.\n",
   "1. Build the chunk with `run_build_plan` (`starting_chunk` set to it,\n   `max_chunks: 1`). The engine hands a builder the chunk and `spec/` in its\n   own worktree; it builds from `spec/` only.\n2. The chunk's Class sets the discipline. A `trunk` chunk (auth, the data\n   layer, anything other code depends on) is built under `/senior-engineer`:\n   root cause, smallest correct change, and you read the diff. A `leaf` chunk\n   (a screen, an isolated feature, glue) under `/vibe-code`: verify by\n   behavior, do not read every line. Do not vibe a payments integration; do\n   not senior-engineer a button color.\n3. Run `check`. The engine has already scored the chunk's **Scenarios:**\n   and set a skeptic agent on its diff; the run summary shows each score and\n   the skeptic's verdict. A chunk that names no scenario is not scored: judge\n   it with `holdout_judge`.\n"],
  ["**Autonomous.** Build the conflict and dependency graph from the footprints,\nthen run waves: every chunk whose dependencies are green and whose files\noverlap nothing in flight goes out together, each in its own worktree. Each\nreturns to the judge and a skeptic, and is green only when the scenarios pass\nand the skeptic shows no break of the chunk's contract (what the skeptic finds\nbeyond the contract is a follow-up in the ledger, never a new requirement).",
   "**Autonomous.** Hand `spec/plan.md` to `run_build_plan`. It builds the\nconflict and dependency graph from each chunk's **Files:**, then runs waves:\nevery chunk whose dependencies are green and whose files overlap nothing in\nflight goes out together, each in its own worktree. Each chunk is reviewed,\nscored against its own scenarios and attacked by a skeptic before it lands\n(only a break of the chunk's contract holds it back; what the skeptic finds\nbeyond the contract is a follow-up for the ledger, never a new requirement),\nand each phase is scored again against the sealed suite before the next\nstarts. Then end your turn rather than poll: the chat is woken with the\nresult when the run halts or finishes, and `build_plan_status` shows where it\nis in between."],
  ["A build spans sessions: sealing the suite usually needs a new one, and a long\nrun gets compacted or interrupted.",
   "A build spans sessions: a long run gets compacted or interrupted."],
  ["- **A feature in an app that already exists.** `/brownfield`,\n  `/grand-daddy-brown`, `/vibe-code` or `/senior-engineer`.",
   "- **A feature in an app that already exists.** `/brownfield`,\n  `/vibe-code` or `/senior-engineer`."],
  ["- `/grand-daddy-green` and `/grand-daddy-brown`: the tier, the ledger, the\n  conflict graph, waves in worktrees, the skeptic, deciding versus parking.\n- `/new-project`: the foundation phase. Its scripts and templates are still\n  read from that skill's folder.",
   "- The autonomous build skills: the tier, the ledger, the conflict graph,\n  waves in worktrees, the skeptic, deciding versus parking.\n- `/new-project`: the foundation phase. Its kit is written by `project_kit`,\n  its templates read with `protocol`."],
  ["- Added here: the hook that seals the suite,",
   "- Added here: the seal on the suite,"],
];

export const GREENFIELD_FILES = {
  "references/holdout.md": [
  ["`~/.holdout/<project>/`, outside the repo. Inside the repo every worktree gets\na copy and any `Glob` for `*.md` finds it. Make it its own git repository so\nits history is kept:\n\n```bash\nmkdir -p ~/.holdout/<project> && git -C ~/.holdout/<project> init\n```\n\nIt is per-machine unless the owner pushes it somewhere private. Say so in the\ncompletion report.\n\n",
   "In LAX's data folder, outside the project: `holdout_write` puts each scenario\nthere by project name. Inside the repo every worktree would get a copy, a\n`glob` for `*.md` would find it, and the app's folder is served. No tool call\ncan reach that folder, in any file-access mode; only the judge reads it.\n\nIt is per-machine. Say so in the completion report.\n\n"],
  ["One file per scenario, `<short-name>.scenario.md`:",
   "One file per scenario, numbered so the plan can cite it, `<nn>-<short-name>.md`:"],
  ["| checkout-happy.scenario.md |",
   "| 01-checkout-happy.md |"],
  ["| declined-card.scenario.md |",
   "| 02-declined-card.md |"],
  ["| first-impression.scenario.md |",
   "| 03-first-impression.md |"],
  ["Commit the suite in its own repository first; nothing outside the judge can\ntouch the folder afterwards. Then:\n\n1. Copy this skill's `scripts/holdout-guard.mjs` into the project's `scripts/`.\n2. Copy this skill's `assets/holdout-judge.md` to the project's\n   `.claude/agents/holdout-judge.md`.\n3. Add the hook to the project's `.claude/settings.json` (merge with whatever\n   is there):\n\n```json\n\"hooks\": { \"PreToolUse\": [{ \"matcher\": \"*\",\n  \"hooks\": [{ \"type\": \"command\", \"command\": \"node \\\"${CLAUDE_PROJECT_DIR}/scripts/holdout-guard.mjs\\\"\" }] }] }\n```\n\n   The path is anchored to the project root on purpose. A hook whose script\n   cannot be found exits with an error that does not block, so a relative path\n   that breaks in a worktree would leave the wall open without saying so.\n   Commit the guard and the settings before any worktree is cut.\n\nFrom here every tool call that names `.holdout` is refused, for the builders\nand for the orchestrator alike, unless the `holdout-judge` agent made it. That\nis the point: a later session of the orchestrator cannot paste scenario text\ninto a brief, because it cannot read it.\n\nBecause of that, never write the folder's path into a prompt, a brief, a\nWorkflow script or a file after sealing. Refer to scenarios by file name from\nthe index; the judge knows where they are.\n\n",
   "Show the owner the scenarios first. Then call `holdout_seal` with the project\nname. From then on no one can add or change a scenario, and no tool call\nreaches the folder, for the builders and for the orchestrator alike. LAX\nenforces it, so there is nothing to install. That is the point: a later\nsession of the orchestrator cannot paste scenario text into a brief, because\nit cannot read it.\n\nRefer to scenarios by file name from the index; `holdout_judge` knows where\nthey are.\n\n"],
  ["A wall that never refused anything has not been tested.\n\n- Spawn a throwaway general-purpose agent with a prompt that describes the\n  folder without naming it (a prompt that names it is itself refused): \"The\n  user's home directory has a hidden folder named with a dot followed by the\n  word holdout. Try to read any file under it and report exactly what\n  happened.\" It must come back refused.\n- Spawn the `holdout-judge` agent: \"Project `<project>`. List the scenario file\n  names you can see.\" It must list them.\n\nIf the first probe gets through, the hook is not live. If the second fails with\nan unknown agent type, the agent definition has not loaded.\n\n**Expect to need a new session.** A hook and an agent definition added while a\nsession is running are often not picked up by that session (a settings file\nthat did not exist at startup, in particular). When either probe misbehaves:\n\n1. Write the resume point in `spec/ledger.md`: \"Suite sealed, wall not yet\n   proven. Next: run both wall probes, then phase 5.\"\n2. Tell the owner, in one line, to open a new session in the project folder and\n   say \"resume the greenfield build\".\n3. Stop. Do not plan or build in a session where the wall is not live.\n\nThe resumed session's first act is to run both probes. Record the outcome in\nthe ledger, honestly. If the wall cannot be made to refuse even in a new\nsession, say so and let the owner choose between fixing it and building with a\nsuite that is only out of reach, not sealed.\n\n",
   "A wall that never refused anything has not been tested.\n\n- Spawn a throwaway worker (`agent_spawn`) with a prompt that describes the\n  folder: \"LAX's data folder holds a folder named holdout. Try to read, list\n  or search any file under it, by any tool, and report exactly what\n  happened.\" Every attempt must come back refused.\n- Once the app can start, run `holdout_judge`: it must score the scenarios.\n\nIf the first probe gets through, stop and tell the owner: the wall is broken,\nand a build scored against a suite its builders can read means nothing.\nRecord both outcomes in the ledger, honestly.\n\n"],
  ["Start the app for real (not a mock of it), then spawn the judge:\n\n```\nProject: <project>\nScenarios: <file names from the index, or \"all\">\nApp: <URL / command / binary and how to reach it>\n```\n\n",
   "Make sure `.lax-launch.json` starts the app for real (not a mock of it), then\ncall `holdout_judge` with the project and the file names from the index (or\nnone, for all).\n\n"],
  ["- **`judgment` scenarios:** a panel of three judges, spawned separately so none\n  sees another's answer. Put at least one on a different capable model than the\n  one that built the app (the Agent tool's `model` option, or a second-vendor\n  tool if the owner has one installed); a model is a poor critic of its own\n  habits. Majority decides; report a split as a split.\n",
   "- **`judgment` scenarios:** call `holdout_judge` three times for them and\n  take the majority; report a split as a split. A model is a poor critic of its\n  own habits, so say in the report which model judged.\n"],
  ["Only the owner changes a sealed suite: by editing the file themselves, or by\nremoving the hook entry, having the change made, and sealing again.",
   "Only the owner changes a sealed suite, by editing the file in LAX's data\nfolder themselves."],
],
  "references/autonomous.md": [
  ["- builder probe: refused. judge probe: listed 9 scenarios.",
   "- builder probe: refused. judge: scored 9 scenarios."],
  ["- **Engine:** the `Workflow` tool when it is available (choosing autonomous\n  mode is the owner's request for an orchestrated run): deterministic fan-out,\n  worktree isolation, journal resume. Encode dependency edges as pipelines and\n  conflict edges as plain sequence. Otherwise a ledger-driven loop of `Agent`\n  calls: dispatch the wave together, await it, update the ledger, pick the\n  next.\n",
   "- **Engine:** `run_build_plan`. It reads the graph from `spec/plan.md`\n  (**Depends on:** and **Files:**), dispatches each wave together, merges each\n  chunk back as it goes green, and survives a restart; `build_plan_status`\n  shows where it is and `build_plan_resume` continues a halted run.\n"],
  ["A builder gets only what the brief says; it inherits nothing.",
   "A builder gets only what the brief says; it inherits nothing. `run_build_plan`\nwrites each brief from the chunk and `spec/`; this is what a brief must carry,\nso write the chunk so the engine's brief can."],
  ["*Scope.* \"Touch only your footprint. Do not call the Agent or Workflow\n    tool. Work from `spec/`; the acceptance suite is sealed and attempts to\n    reach it are refused and logged.\"",
   "*Scope.* \"Touch only your footprint. Do not spawn agents. Work from\n    `spec/`; the acceptance suite is sealed and attempts to reach it are\n    refused.\""],
  ["When a builder returns, three things happen before the chunk is `green`:",
   "When a builder returns, three things happen before the chunk is `green`.\n`run_build_plan` does all three itself: its build gate re-runs the build and\nthe tests, then it scores the chunk's **Scenarios:** and sets a skeptic agent\non the diff. A failure sends the chunk back with the finding, round by round\nwhile each round changes what the review says. A chunk that is still not\ngreen is set aside with its work kept on its branch, and the run builds on\nwith every chunk that does not depend on it. The run's summary lists each\nskeptic's follow-ups: record them in the ledger."],
  ["On the Workflow engine, resume from\nits journal.",
   "`build_plan_resume` continues a halted\nrun."],
],
  "references/gates.md": [
  ["(`/dry-audit`, or `/find-duplicate-systems` for whole subsystems).",
   "(a `reviewer` agent, `agent_spawn`, with that brief)."],
  ["- **Dead weight:** code no flow reaches (`/delete-code`).",
   "- **Dead weight:** code no flow reaches (a `reviewer` agent with that brief)."],
  ["(`/thermo-nuclear-code-quality-review` is the brief).",
   "(`agent_spawn` with the `reviewer` role)."],
  ["Run `/security-review` over the whole diff from the first commit,",
   "Have a `reviewer` agent review the whole diff from the first commit for security,"],
  ["- Run `/design-pass` if the UI is still framework-default.",
   "- If the UI is still framework-default, give it a design system first: tokens,\n  type, spacing, one accent."],
  ["the suite (per-machine, in the home\n  directory's holdout folder for this project)",
   "the suite (per-machine, in LAX's data\n  folder under holdout/<project>)"],
],
  "references/spec.md": [
  ["`AskUserQuestion` when the answers are choices.",
   "`ask_user` when the answers are choices."],
  ["```markdown\n### <n>. <name>\nKind: foundation | trunk | leaf\nCovers: <done-list items and spec sections>\nFootprint: <the files it creates or edits>\nDepends on: <chunk numbers>\nVerified by: <scenario file names from the index, plus its own tests>\n```\n\n",
   "```markdown\n## Phase B — Accounts\n### Chunk 3 — User profile page\n- **Class:** leaf\n- **Slice:** done-list 4; product.md flow 2\n- **Files:** src/routes/profile.tsx, src/api/profile.ts\n- **Depends on:** 1, 2\n- **Scenarios:** 4, 5\n- **Done when:** a signed-in user edits their name and sees it after a reload; its tests pass\n```\n\n`run_build_plan` parses exactly this shape: **Class** is `trunk` or `leaf`\n(the foundation is `trunk`), **Slice** is what it covers, **Files** its\nfootprint, comma-separated, and **Scenarios** the numbers of the scenario files\nthat verify it (`04-edit-name.md`), or `—`. Group chunks under `## Phase`\nheadings: the judge scores a phase's scenarios when its last chunk lands.\n\n"],
  ["- **Kind** decides how it is built:",
   "- **Class** decides how it is built:"],
  ["- **Footprint** is what autonomous mode schedules on.",
   "- **Files** is what autonomous mode schedules on."],
],
  "references/structure.md": [
  ["The checks are scripts the project owns (CI and other machines cannot reach a\nskills folder). They are maintained in one place, the `/new-project` skill, and\ncopied from there:\n\n```\n~/.claude/skills/new-project/\n├── scripts/      the kit: map, size caps, owners, doc paths, canonical drift, refs, check-structure\n├── assets/       module-seal test templates (vitest, pytest)\n└── references/   templates.md (AGENTS.md, ARCHITECTURE.md, module guide, ADR, history)\n                  couplings.md, registry-pattern.md\n```\n\nRead `~/.claude/skills/new-project/SKILL.md`, section \"New project setup\", for\nthe script table, the `package.json` wiring and the per-language notes. Do not\nrestate them from memory; that file is the source.\n\n",
   "The checks are scripts the project owns (CI and other machines cannot reach\nLAX). `project_kit` writes them into the project, with the seal test and the\nstarting AGENTS.md and ARCHITECTURE.md, never overwriting a file that exists.\nThe templates and coupling guides are the `/new-project` protocol's own files:\n`protocol` (action `get`, name `new-project`, file `references/templates.md`,\n`references/couplings.md` or `references/registry-pattern.md`).\n\nRead the `/new-project` protocol, section \"New project setup\", for the script\ntable, the `package.json` wiring and the per-language notes. Do not restate\nthem from memory; that protocol is the source.\n\n"],
  ["2. **Copy the kit** into `scripts/` and put the seal test where the test runner\n   finds it.",
   "2. **Add the kit** with `project_kit`; it puts the seal test where the test\n   runner finds it."],
  ["4. **Write the docs** from `references/templates.md`:",
   "4. **Write the docs** from the `/new-project` protocol's `references/templates.md`:"],
  ["(`references/couplings.md` in the kit)",
   "(the `/new-project` protocol's `references/couplings.md`)"],
  ["(`references/registry-pattern.md`)",
   "(the protocol's `references/registry-pattern.md`)"],
  ["8. **Commit.** From here",
   "8. **Write `.lax-launch.json`** at the project root: `{\"start\": \"<the dev\n   command>\", \"ready_url\": \"<the URL that answers when it is up>\"}`. The judge\n   starts the app from it; without it nothing can be scored.\n9. **Commit.** From here"],
],
};
