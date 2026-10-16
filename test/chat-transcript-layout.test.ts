// The chat transcript (#messages) is a fixed-height flex column that scrolls.
// Its entries are flex items, which shrink to fit the column unless something
// stops them; min-height:auto used to be the only thing that did, so a rule
// giving an entry min-height:0 (the newest reply's reserve, dropped while the
// secret card follows it) collapsed the reply to nothing and spilled its
// thinking and activity rows over the card. Layout can't be measured
// headlessly, so the invariants are pinned on the stylesheets instead.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssDir = join(here, "../public/css");
const flat = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
const appCss = flat(readFileSync(join(cssDir, "app.css"), "utf8"));

/** Every `selector{body}` rule in every stylesheet, at-rule wrappers included. */
function allRules(): Array<{ file: string; selector: string; body: string }> {
  return readdirSync(cssDir).filter((f) => f.endsWith(".css")).flatMap((file) => {
    const css = flat(readFileSync(join(cssDir, file), "utf8"));
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, selector: m[1].trim(), body: m[2] }));
  });
}

describe("chat transcript layout (CSS invariants)", () => {
  it("the transcript is a flex column that scrolls", () => {
    const rule = appCss.match(/#messages\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/display:flex/);
    expect(rule).toMatch(/flex-direction:column/);
    expect(rule).toMatch(/overflow-y:auto/);
  });

  it("an entry in the transcript never shrinks", () => {
    expect(appCss).toMatch(/#messages > \*\{flex-shrink:0\}/);
  });

  it("no stylesheet lets an entry in the transcript shrink again", () => {
    // An entry is what one compound after #messages selects (`#messages > *`,
    // `#messages .msg.assistant`). `#chat-main #messages` is the transcript
    // itself, which may flex; deeper parts style a message's own insides.
    const inside = (selector: string) => selector.split(",").some((part) => /#messages(?![\w-])\s*>?\s*[^\s>+~]+$/.test(part.trim()));
    const shrinks = (body: string) =>
      /flex-shrink:\s*[1-9]/.test(body) || /(^|;)\s*flex:\s*(\d+\s+[1-9]|[1-9][\d.]*\s*(;|$)|auto|initial)/.test(body);
    const offenders = allRules().filter(({ selector, body }) => inside(selector) && shrinks(body));
    expect(offenders.map((r) => `${r.file}: ${r.selector}`)).toEqual([]);
  });

  it("the secret card spans the message column, like the messages it follows", () => {
    expect(appCss).toMatch(/#secret-modal-overlay\.visible\{[^}]*width:100%[^}]*max-width:800px/);
    expect(appCss).toMatch(/\.msg\{max-width:800px;width:100%\}/);
  });
});
