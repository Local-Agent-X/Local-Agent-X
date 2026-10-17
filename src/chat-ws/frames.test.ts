// Two sides of the chat socket, checked against each other. The server side
// is GlobalFrame (every producer is typed to it) and the session event types
// the relay contract mirrors from the ServerEvent union. The
// browser side is plain script in public/js that switches on `msg.type` /
// `event.type`; this test reads those switches with the TypeScript parser.
// A frame nobody handles is a notification that reaches no one (an urgent
// agent escalation was one); a handler for a frame nobody sends is a dead
// branch that looks like a feature (the IDE panel listened for `agent_spawn`
// while the server sent `agent-spawn`).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import fg from "fast-glob";
import { GLOBAL_FRAME_TYPES } from "./frames.js";
import { SESSION_EVENT_TYPES } from "../canonical-loop/public/process-relay.js";
import { BROADCAST_KEYS } from "../settings-schema.js";

/** The browser files that dispatch on a chat-socket frame's or event's type.
 *  The voice socket (chat-voice-ws-handler.js) is its own protocol. */
const DISPATCHERS = [
  "public/js/chat-ws-handler.js",
  "public/js/chat-ws-handler-misc.js",
  "public/js/chat-ws-handler-chat-events.js",
  "public/js/chat-ws-handler-bg-ops.js",
  "public/js/chat-stream-reducer.js",
  "public/js/chat-stream-admit.js",
  "public/js/chat-approval-rediscovery.js",
  "public/js/apps-ide-ws.js",
  "public/js/notifications.js",
  "public/js/thinking-phrases.js",
];

/** Frames with no browser handler, each with why. */
const NO_BROWSER_CONSUMER: Record<string, string> = {
  "app:state": "a pinned app's own page polls GET /api/apps/:id/state; the chat shell has nothing to redraw",
  "app:event": "consumed by the app runtime's own clients, not the chat shell",
};

/** `settings_changed` keys the tab deliberately does not redraw for. */
const SETTINGS_WITHOUT_TAB_HANDLER: Record<string, string> = {
  allowRuntimeFailover: "no card shows it; the server reads it when a run's provider fails",
  localClassifierModel: "no card shows it; the server reads it when a classifier call is routed",
};

interface Consumed { name: string; where: string }

/** `X.type === 'lit'` comparisons and `switch (X.type) { case 'lit': }` cases
 *  where X is a frame or event variable (`msg`, `msg.event`, `event`, `ev`),
 *  not a block, chip or phase of the client's own model. */
function consumedTypes(file: string): Consumed[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Consumed[] = [];
  const isTypeAccess = (e: ts.Expression) =>
    ts.isPropertyAccessExpression(e) && e.name.text === "type" && /^(msg|msg\.event|event|ev|frame|e)$/.test(e.expression.getText());
  const at = (n: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const isEquality = (kind: ts.SyntaxKind) => kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isEquality(node.operatorToken.kind)) {
      if (isTypeAccess(node.left) && ts.isStringLiteralLike(node.right)) out.push({ name: node.right.text, where: at(node) });
      if (isTypeAccess(node.right) && ts.isStringLiteralLike(node.left)) out.push({ name: node.left.text, where: at(node) });
    }
    if (ts.isSwitchStatement(node) && isTypeAccess(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) out.push({ name: clause.expression.text, where: at(clause) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The literal keys of every `settings: { … }` a settings_changed producer
 *  spells out in src (the setting tool's computed `[fieldName]` is covered by
 *  BROADCAST_KEYS). */
function producedSettingsKeys(): Set<string> {
  const keys = new Set<string>(BROADCAST_KEYS);
  for (const file of fg.sync(["src/**/*.ts"], { ignore: ["**/*.test.ts", "**/vendor/**"] })) {
    const text = readFileSync(file, "utf8");
    if (!text.includes('"settings_changed"')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && node.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "type" && ts.isStringLiteralLike(p.initializer) && p.initializer.text === "settings_changed")) {
        const settings = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "settings");
        if (settings && ts.isObjectLiteralExpression(settings.initializer)) {
          for (const p of settings.initializer.properties) {
            if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)) keys.add(p.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return keys;
}

/** The keys handleSettingsChanged (chat-ws-handler-misc.js) reads off
 *  msg.settings: `'key' in msg.settings`, `msg.settings.key`, and the Tool
 *  Policy card's field list it re-reads the card for. */
function handledSettingsKeys(): Set<string> {
  const text = readFileSync("public/js/chat-ws-handler-misc.js", "utf8");
  const keys = new Set<string>();
  for (const m of text.matchAll(/'([A-Za-z_]+)' in msg\.settings/g)) keys.add(m[1]);
  for (const m of text.matchAll(/msg\.settings\.([A-Za-z_]+)/g)) keys.add(m[1]);
  const card = text.match(/TOOL_POLICY_CARD_FIELDS = \[([^\]]*)\]/);
  for (const m of (card?.[1] ?? "").matchAll(/'([A-Za-z_]+)'/g)) keys.add(m[1]);
  return keys;
}

describe("every chat-socket frame has a producer and a browser consumer", () => {
  const consumed = DISPATCHERS.flatMap(consumedTypes);
  const consumedNames = new Set(consumed.map((c) => c.name));

  it("every frame the server sends is handled by a tab, or says why not", () => {
    const unhandled = GLOBAL_FRAME_TYPES.filter((t) => !consumedNames.has(t) && !(t in NO_BROWSER_CONSUMER));
    expect(unhandled, "add a handler in public/js (the dispatchers above) or an entry in NO_BROWSER_CONSUMER").toEqual([]);
    const stale = Object.keys(NO_BROWSER_CONSUMER).filter((t) => consumedNames.has(t) || !(GLOBAL_FRAME_TYPES as readonly string[]).includes(t));
    expect(stale, "the frame is now handled or no longer sent — drop its entry").toEqual([]);
  });

  it("every type a tab dispatches on is a frame or a session event the server sends", () => {
    const known = new Set<string>([...GLOBAL_FRAME_TYPES, ...SESSION_EVENT_TYPES]);
    const dead = consumed.filter((c) => !known.has(c.name)).map((c) => `${c.name} (${c.where})`);
    expect(dead, "a dead branch: nothing sends this type — fix the name or remove the case").toEqual([]);
  });

  it("every settings_changed key a producer sends is redrawn by the tab, or says why not", () => {
    const handled = handledSettingsKeys();
    const produced = [...producedSettingsKeys()].sort();
    expect(produced).toEqual(expect.arrayContaining(["theme", "provider", "egress", "sandbox", "plugins", "secrets", "mcpServers"]));
    const unhandled = produced.filter((k) => !handled.has(k) && !(k in SETTINGS_WITHOUT_TAB_HANDLER));
    expect(unhandled, "handleSettingsChanged (public/js/chat-ws-handler-misc.js) ignores these keys: other tabs stay stale").toEqual([]);
    const stale = Object.keys(SETTINGS_WITHOUT_TAB_HANDLER).filter((k) => handled.has(k) || !produced.includes(k));
    expect(stale).toEqual([]);
  });
});
