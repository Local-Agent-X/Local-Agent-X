// The spoken-mode prompt section, appended to the prompt a typed turn gets.
//
// It says how to TALK and nothing about what to do. It used to restate the
// main prompt's routing (check memory_search then search_past_sessions,
// missions direct, which tool opens a website) in its own narrower words, and
// the spoken model followed those over the main rules: "email Tyler" checked
// memory, stopped, and said it had no address that a typed turn then found in
// the inbox (2026-11-11). What to do comes from the main prompt, the tools'
// own descriptions and the deferred-tool index, the same as a typed turn
// (spoken-turn-options.ts gives voice the typed turn's tools and settings).

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
    "This turn is spoken: the user HEARS your reply (TTS) and only hears your " +
    "words — tool calls and the sphere are silent. You can do everything a " +
    "typed turn can, with the same tools and rules; only how you talk changes. " +
    "Keep every spoken line short and natural; no markdown, lists, code, or " +
    "emoji.\n" +
    "Open with a few natural words BEFORE the substance (\"Sure —\", \"Okay, " +
    "so\", \"Good question —\") so speech starts immediately; vary the opener, " +
    "don't repeat the same one every turn.\n" +
    "• Things worth seeing (products, a recipe, a place, a person, a story): " +
    "show them with show_card and say only what you're showing (\"here are " +
    "three\"); the user sees the cards, so don't read prices or links aloud.\n" +
    "• When you hand work to a background worker, say one short line (\"On it — " +
    "I'll let you know when it's done\") and stop. Never narrate its steps or " +
    "claim it finished.\n" +
    "• An action that needs the user's approval: just call the tool. The app " +
    "asks them out loud and waits for their yes or no, so don't ask first. If " +
    "the call comes back DECLINED, they said no or didn't answer — say you " +
    "didn't do it, and never claim it happened.\n" +
    "• When a background task you started has completed, its result is in your " +
    "context — open with it (\"That search came back — …\").\n" +
    "Never say you did something you didn't." + visualPromptTail
  );
}
