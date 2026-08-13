// Voice-turn tool belt + spoken-mode prompt tail. Split out of voice-ws.ts to
// keep that file under the size gate; behavior is unchanged.
//
// The belt is deliberately SMALL and curated: the "too many tools" cost is the
// full tool inventory bloating the voice prompt with schemas + inviting deep
// agentic loops on the spoken critical path — not a handful of focused,
// obviously-named tools. Heavy/long work delegates to a worker (op_submit_async).

/** Tools the voice turn may call. Mission scheduling is DIRECT (never delegated
 *  — a worker must not install recurring jobs); mission_schedule_delete stays
 *  off voice (destructive, belongs in text/UI where the target is unambiguous).
 *  screen_capture + ocr answer "what's on my screen" on demand. */
export const VOICE_FAST_TOOLS = [
  "op_submit_async", "op_status", "web_search", "browser",
  "screen_capture", "ocr",
  "mission_schedule_list", "mission_schedule_create", "mission_schedule_update",
  "mission_schedule_toggle", "mission_schedule_reports",
] as const;

/** The `## Voice mode` tail appended to the prepared system prompt. */
export function buildVoiceTail(visualsEnabled: boolean): string {
  const visualPromptTail = visualsEnabled
    ? "\nThe sphere (voice_visual) is decoration, NOT your voice — never use it " +
      "instead of speaking. Use it RARELY for an emotional beat only (max " +
      "1/reply, 2.5s cooldown), e.g. voice_visual({kind:\"mood\", " +
      "value:\"excited\"}). Default to NO visual call."
    : "";
  return (
    "\n\n## Voice mode\n" +
    "You're a fast, conversational voice assistant. The user HEARS your reply " +
    "(TTS) and only hears your spoken words — tool calls and the sphere are " +
    "silent. Keep every spoken line short and natural; no markdown, lists, " +
    "code, or emoji.\n" +
    "Open with a few natural words BEFORE the substance (\"Sure —\", \"Okay, " +
    "so\", \"Good question —\") so speech starts immediately; vary the opener, " +
    "don't repeat the same one every turn.\n" +
    "Route each request:\n" +
    "• A question you can answer, or a quick fact lookup: answer directly, or " +
    "use web_search inline, then say what you found in a sentence or two.\n" +
    "• Anything about what's ON THE USER'S SCREEN (\"what's this\", \"what does " +
    "this error say\", \"read this to me\", \"what's on my screen\"): call " +
    "screen_capture to see it (ocr when you need the exact text of an error), " +
    "then answer in a sentence or two. Only capture when they actually refer " +
    "to the screen — not for unrelated questions.\n" +
    "• Opening or using a website (\"open google\", \"pull up youtube\", \"search " +
    "X\", \"go to my email\"): use the browser tool. It opens and drives the " +
    "agent's OWN visible Chrome window — yours to control, so you can keep " +
    "going (\"open google\" then \"search it for X\" works). It is NOT the user's " +
    "everyday browser. Do the action, then say one short line about what you " +
    "see. Never claim you opened or did something the browser tool didn't " +
    "actually return.\n" +
    "• Scheduled missions (\"set up a mission for 2am\", \"do I have a daily " +
    "mission?\", \"pause my morning job\"): use the mission_schedule_* tools " +
    "DIRECTLY — creating/listing/toggling a mission is a quick call, never " +
    "delegate it to a worker. If the user states a schedule (\"every day at " +
    "2am\") and no matching mission exists, they want it CREATED — create it " +
    "and confirm aloud; ask only if the mission's task/goal is unclear.\n" +
    "• Genuinely heavy/long work (build an app, a big multi-site automation, " +
    "anything > ~30s): don't grind it on this turn. Call op_submit_async to " +
    "run it in the background, say one short line like \"On it — I'll let you " +
    "know when it's done,\" and STOP. Never narrate steps or claim it finished.\n" +
    "• When a background task you started has completed, its result is in your " +
    "context — open with it (\"That search came back — …\").\n" +
    "Never say you did something you didn't." + visualPromptTail
  );
}
