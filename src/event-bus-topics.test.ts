// A bus topic is a contract between an emitter and a listener. One that only
// ever fires is a feature that silently does nothing (the agency's pause,
// resume and cancel events, `handler:agent-user-input` meant to unblock a
// waiting agent, the app lifecycle events — none had a listener); one that is
// only ever listened for is dead code. This scan reads every emit and every
// listener registration in src and holds EVENT_TOPICS to both.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import fg from "fast-glob";
import { EVENT_TOPICS } from "./event-bus.js";

interface Sites { emits: Map<string, string[]>; listens: Map<string, string[]> }

function scan(): Sites {
  const sites: Sites = { emits: new Map(), listens: new Map() };
  const add = (map: Map<string, string[]>, topic: string, where: string) => map.set(topic, [...(map.get(topic) ?? []), where]);
  for (const file of fg.sync(["src/**/*.ts"], { ignore: ["**/*.test.ts", "**/*.test-helper.ts", "**/vendor/**"] })) {
    const text = readFileSync(file, "utf8");
    if (!/[eE]ventBus\./.test(text)) continue;
    for (const m of text.matchAll(/[eE]ventBus\.emit\(\s*"([^"]+)"/g)) add(sites.emits, m[1], file);
    for (const m of text.matchAll(/[eE]ventBus\.(?:on|once)\(\s*"([^"]+)"/g)) add(sites.listens, m[1], file);
  }
  return sites;
}

const listensTo = (sites: Sites, topic: string): boolean =>
  sites.listens.has(topic) || [...sites.listens.keys()].some((p) => p.endsWith(":*") && topic.startsWith(p.slice(0, -1)));

describe("every event-bus topic has an emitter and a listener", () => {
  const sites = scan();

  it("every declared topic is fired somewhere and heard somewhere", () => {
    const silent = EVENT_TOPICS.filter((t) => !sites.emits.has(t));
    const unheard = EVENT_TOPICS.filter((t) => !listensTo(sites, t));
    expect(silent, "a topic nothing emits: drop it from EventTopics").toEqual([]);
    expect(unheard, "a topic nothing listens for: wire the consumer or drop the emit and the topic").toEqual([]);
  });

  it("every topic the code names is declared (the compiler checks the literal; this checks the pattern listeners)", () => {
    const declared = new Set<string>(EVENT_TOPICS);
    const unknownEmits = [...sites.emits.keys()].filter((t) => !declared.has(t));
    const unknownListens = [...sites.listens.keys()].filter((t) => !declared.has(t) && !(t.endsWith(":*") && EVENT_TOPICS.some((d) => d.startsWith(t.slice(0, -1)))));
    expect(unknownEmits).toEqual([]);
    expect(unknownListens, "a pattern listener whose prefix matches no topic").toEqual([]);
  });
});
