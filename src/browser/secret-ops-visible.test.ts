// @vitest-environment happy-dom
//
// The page script behind the screenshot check reports what the page calls each
// field and whether it sits in a dialog: an id in a field named "Account SID"
// is not a secret, a random string in one named "API key" is.
import { beforeAll, describe, expect, it } from "vitest";
import { visibleValuesScript, type VisibleValue } from "./secret-ops.js";

// This project compiles without the DOM lib.
const dom = globalThis as unknown as {
  document: { body: { innerHTML: string } };
  HTMLElement: { prototype: { getBoundingClientRect: () => unknown } };
};

const run = () => (0, eval)(visibleValuesScript()) as VisibleValue[];

beforeAll(() => {
  // happy-dom lays nothing out; give every element a visible box.
  dom.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 20 });
});

describe("visibleValuesScript", () => {
  it("names each field by its label, aria-label, placeholder, name and id", () => {
    dom.document.body.innerHTML =
      `<label for="sid">Account SID</label><input id="sid" value="AC84d9ce8b2c77c8bc9f9423650da3d1d9">` +
      `<span id="lbl">API key</span><input aria-labelledby="lbl" name="k" value="x1">`;
    const [sid, key] = run();
    expect(sid.names).toContain("Account SID");
    expect(sid.inDialog).toBe(false);
    expect(key.names).toEqual(expect.arrayContaining(["API key", "k"]));
  });

  it("marks a field inside a dialog", () => {
    dom.document.body.innerHTML = `<div role="dialog"><input value="new-token-value"></div>`;
    expect(run()[0].inDialog).toBe(true);
  });
});
