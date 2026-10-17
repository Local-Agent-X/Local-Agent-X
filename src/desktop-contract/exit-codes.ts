// Exit codes the server child uses to tell Electron main something other than
// "crashed". Main keys its recovery on them (desktop/src/server-process.ts).

/** EX_TEMPFAIL: another LAX server already owns the pidfile. Not a crash —
 *  main shows the "already running" recovery instead of restarting into the
 *  same refusal. */
export const EXIT_ALREADY_RUNNING = 75;
