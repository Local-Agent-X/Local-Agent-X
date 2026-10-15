// The op types the harness creates and branches on: the one place their names are
// spelled. Op.type stays an open string (a model may label a delegated op anything),
// so code that recognizes a harness op compares against these constants, never a
// written-out literal. A misspelled literal compiles and silently never matches: the
// app design guard skipped ops typed "build_app" while builds are "app_build", so it
// told every build to redo its UI and pasted the design system in again (2026-10-14).
// op-types.test.ts fails on a raw literal compared with an op type anywhere in src/.
//
// Leaf module: no imports, so any layer can use it without a cycle.

export const OP_TYPE = {
  /** One interactive chat turn (chat-runner/create-op.ts). */
  chatTurn: "chat_turn",
  /** One voice-session turn (server/voice-ws.ts). */
  voiceTurn: "voice_turn",
  /** A build_app tool run (tools/build-app.ts). */
  appBuild: "app_build",
  /** An app build a background worker runs (server/background-jobs/worker-runner.ts). */
  appBuilder: "app_builder",
  /** A spawned sub-agent (server/handler-events.ts). */
  agentSpawn: "agent_spawn",
  /** A cron job's run (server/background-jobs/cron-runner.ts). */
  scheduledMission: "scheduled_mission",
  /** The background memory pass (server/background-jobs/dream-check.ts). */
  memoryConsolidation: "memory_consolidation",
  /** The background skill reviewer (server/background-jobs/skill-review.ts). */
  skillReview: "skill_review",
  /** A self-repair run (server/background-jobs/self-edit-surgeon-runner.ts). */
  selfEdit: "self_edit",
  /** An auto-build orchestration (auto-build/orchestrator/manager.ts). */
  orchestrator: "orchestrator",
  /** One autopilot round (autopilot/round-agent.ts). */
  autopilotRound: "autopilot_round",
  /** A chat turn handed to a background op (routes/chat/delegation-handoff.ts). */
  freeform: "freeform",
  /** The short acknowledgement turn of a delegation (routes/chat/delegation-handoff.ts). */
  delegationAck: "delegation_ack",
  /** The fresh-context review of a publish (canonical-loop/publish-review-submit.ts). */
  reviewPublish: "review_publish",
  /** The fresh-context check of a deliverable (canonical-loop/verification-submit.ts). */
  verifyDeliverable: "verify_deliverable",
} as const;

export type HarnessOpType = (typeof OP_TYPE)[keyof typeof OP_TYPE];

/** Labels a MODEL gives the ops it delegates (op_submit's `type`, ops/tools/shared.ts)
 *  that the harness still treats specially. Not harness op types: nothing creates them
 *  by these names, a model chooses them. */
export const DELEGATED_OP_LABEL = {
  /** A delegated op the model labelled as an app build: it needs the in-process
   *  runtime (dev servers), like a real build. */
  buildApp: "build_app",
} as const;
