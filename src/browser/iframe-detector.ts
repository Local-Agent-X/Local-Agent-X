/**
 * List iframes on the page so the agent knows OAuth/Stripe/captcha widgets
 * exist. Cross-origin frames cannot be queried for refs (browser security),
 * so we surface their src + position separately and tell the agent to use
 * evaluate or click their container instead of expecting a ref inside.
 */
import type { Page } from "playwright";

export interface IframeInfo {
  src: string;
  origin: string;
  rect: { x: number; y: number; width: number; height: number };
  crossOrigin: boolean;
  /** A provider response field beside the frame (g-recaptcha-response,
   *  h-captcha-response, cf-turnstile-response) already holds a token: the
   *  verification this frame shows has been completed. */
  answered: boolean;
}

export async function listIframes(page: Page): Promise<IframeInfo[]> {
  const pageOrigin = safeOrigin(page.url());
  const script = `(() => {
    const out = [];
    for (const f of document.querySelectorAll('iframe, frame')) {
      const r = f.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const src = f.src || f.getAttribute('src') || '';
      let origin = '';
      try { origin = new URL(src, location.href).origin; } catch {}
      let answered = false;
      for (let el = f.parentElement, i = 0; el && i < 3; el = el.parentElement, i++) {
        const field = el.querySelector('textarea[name$="-response"], input[name$="-response"]');
        if (field) { answered = !!field.value; break; }
      }
      out.push({
        src: src,
        origin: origin,
        answered: answered,
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) },
      });
    }
    // A verification widget whose frame the page hides from this scan
    // (Cloudflare Turnstile renders inside a closed shadow root) is still
    // announced in the page itself: its host carries the provider's site key,
    // and the provider's response field sits beside it. It is reported here
    // as the frame it renders, sized by its visible host. Hosts with a frame
    // the loop above already saw, invisible-mode hosts, and controls bound to
    // an invisible challenge (a submit button) are left out.
    const RESPONSE = 'input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="captcha"]';
    const frameFor = (host) => {
      const key = host.getAttribute('data-sitekey') || host.getAttribute('data-captcha-sitekey') || '';
      const cls = typeof host.className === 'string' ? host.className : '';
      if (/^0x4/.test(key) || /cf-turnstile/.test(cls) || host.querySelector('input[name="cf-turnstile-response"]')) return 'https://challenges.cloudflare.com/turnstile/widget';
      if (/^6L/.test(key) || /g-recaptcha/.test(cls)) return 'https://www.google.com/recaptcha/api2/anchor';
      if (/h-captcha/.test(cls) || /^[0-9a-f]{8}-/.test(key)) return 'https://hcaptcha.com/captcha/widget';
      return '';
    };
    const hosts = new Set();
    for (const h of document.querySelectorAll('[data-sitekey], [data-captcha-sitekey], .cf-turnstile, .g-recaptcha, .h-captcha')) hosts.add(h);
    for (const field of document.querySelectorAll(RESPONSE)) if (field.parentElement) hosts.add(field.parentElement);
    for (const host of hosts) {
      if (/^(BUTTON|INPUT|A|FORM)$/.test(host.tagName) || host.getAttribute('data-size') === 'invisible') continue;
      if (host.querySelector('iframe')) continue;
      const r = host.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const src = frameFor(host);
      if (!src) continue;
      const field = host.querySelector(RESPONSE);
      out.push({
        src: src,
        origin: new URL(src).origin,
        answered: !!(field && field.value),
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) },
      });
    }
    return out;
  })()`;
  const raw = (await page.evaluate(script).catch(() => [])) as Array<Omit<IframeInfo, "crossOrigin">>;
  return raw.map((f) => ({
    ...f,
    crossOrigin: !!f.origin && f.origin !== pageOrigin,
  }));
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}
