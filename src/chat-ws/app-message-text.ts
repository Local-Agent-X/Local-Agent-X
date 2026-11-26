/**
 * Whether a chat message was sent by the app, not typed by the user. Every
 * message the app sends a chat (app-message.ts's callers, a collab's briefs,
 * a build decision for the build's lead) opens with a parenthesized line that
 * says it was "not typed by the user". The same rule as the desktop's
 * public/js/chat-app-message.js and the phone's chat/appMessageText.ts.
 */
export function isSentByApp(text: string): boolean {
  const body = text.trimStart();
  if (!body.startsWith("(")) return false;
  return (body.split("\n")[0] ?? "").includes("not typed by the user");
}
