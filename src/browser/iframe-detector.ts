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
      out.push({
        src: src,
        origin: origin,
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
