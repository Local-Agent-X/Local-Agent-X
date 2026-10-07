// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true}}
//
// The frame listing runs as a script inside the page; this runs that script
// against a real DOM.
import { beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { listIframes } from "./iframe-detector.js";

// This project compiles without the DOM lib.
const dom = globalThis as unknown as {
  document: { body: { innerHTML: string } };
  HTMLElement: { prototype: { getBoundingClientRect: () => unknown } };
};

const page = {
  url: () => "https://shop.example/checkout",
  evaluate: async (script: string) => (0, eval)(script) as unknown,
} as unknown as Page;

const RECAPTCHA = "https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=normal";

beforeAll(() => {
  // happy-dom lays nothing out; give every element a visible box.
  dom.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, width: 304, height: 78 });
});

describe("listIframes: whether a verification widget was completed", () => {
  it("is unanswered while the provider's response field is empty", async () => {
    dom.document.body.innerHTML =
      `<div class="g-recaptcha"><div><iframe src="${RECAPTCHA}"></iframe></div><textarea name="g-recaptcha-response"></textarea></div>`;
    const [frame] = await listIframes(page);
    expect(frame.crossOrigin).toBe(true);
    expect(frame.answered).toBe(false);
  });

  it("is answered once the response field holds a token", async () => {
    dom.document.body.innerHTML =
      `<div class="cf-turnstile"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2"></iframe><input type="hidden" name="cf-turnstile-response" value="0.zQ3abc"></div>`;
    const [frame] = await listIframes(page);
    expect(frame.answered).toBe(true);
  });

  it("is unanswered for a frame with no response field near it", async () => {
    dom.document.body.innerHTML = `<main><section><div><iframe src="https://js.stripe.com/v3/elements"></iframe></div></section></main>`;
    const [frame] = await listIframes(page);
    expect(frame.answered).toBe(false);
  });
});

// Twilio's login (Auth0) showed a Cloudflare "Verify you are human" box the
// agent never saw: Turnstile renders its frame inside a closed shadow root, so
// the frame scan found nothing and the agent told the user to re-enter their
// password. The widget is still announced in the page by its host's site key
// and the provider's response field.
describe("listIframes: a verification widget whose frame the page hides", () => {
  const TURNSTILE = (value = "") =>
    `<form><div class="cf-turnstile" data-sitekey="0x4AAAAAAADnPIDROrmt1Wwj"><input type="hidden" name="cf-turnstile-response" value="${value}"></div></form>`;
  const hideFrame = () => {
    const host = (dom.document as unknown as { querySelector(s: string): { attachShadow(o: { mode: string }): { innerHTML: string } } }).querySelector(".cf-turnstile");
    host.attachShadow({ mode: "closed" }).innerHTML = `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2"></iframe>`;
  };

  it("reports a shadow-hosted Turnstile as an unanswered challenge frame", async () => {
    dom.document.body.innerHTML = TURNSTILE();
    hideFrame();
    const frames = await listIframes(page);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ src: "https://challenges.cloudflare.com/turnstile/widget", crossOrigin: true, answered: false });
  });

  it("reports it answered once the response field holds a token", async () => {
    dom.document.body.innerHTML = TURNSTILE("0.zQ3abc");
    hideFrame();
    expect((await listIframes(page))[0].answered).toBe(true);
  });

  it("does not report a submit button bound to an invisible challenge", async () => {
    dom.document.body.innerHTML = `<form><button class="g-recaptcha" data-sitekey="6LcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">Sign in</button></form>`;
    expect(await listIframes(page)).toEqual([]);
  });

  it("does not count a widget twice when its frame is already visible", async () => {
    dom.document.body.innerHTML = `<div class="g-recaptcha" data-sitekey="6LcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"><iframe src="${RECAPTCHA}"></iframe><textarea name="g-recaptcha-response"></textarea></div>`;
    const frames = await listIframes(page);
    expect(frames.map((f) => f.src)).toEqual([RECAPTCHA]);
  });
});
