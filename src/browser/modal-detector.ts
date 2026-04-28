/**
 * Detect overlays/modals/banners that block normal page interaction.
 *
 * Heuristics: explicit role=dialog / aria-modal=true, plus position:fixed-or-
 * sticky elements that either match cookie/consent class hints, span >25% of
 * the viewport with z-index ≥ 100, or sit in the bottom-banner region. For
 * each obstruction we try to locate accept and dismiss buttons by visible
 * text so the agent can be told "click [N] to dismiss" instead of guessing.
 *
 * The XPath returned here uses the same algorithm as extract.ts so callers
 * can resolve it back to a DurableRef.
 */
import type { Page } from "playwright";

export type ObstructionKind = "modal" | "cookie" | "newsletter" | "overlay";

export interface Obstruction {
  kind: ObstructionKind;
  role: string;
  name: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  acceptXPath: string | null;
  acceptText: string | null;
  dismissXPath: string | null;
  dismissText: string | null;
  zIndex: number;
}

export async function detectObstructions(page: Page): Promise<Obstruction[]> {
  const viewport = page.viewportSize() || { width: 1280, height: 800 };
  const argsJson = JSON.stringify(viewport);
  const script = `${OBSTRUCTION_SCRIPT}(${argsJson})`;
  const result = await page.evaluate(script).catch(() => []);
  return Array.isArray(result) ? (result as Obstruction[]) : [];
}

const OBSTRUCTION_SCRIPT = `(function(viewport) {
  const vw = viewport.width;
  const vh = viewport.height;
  const vpArea = vw * vh;

  function xpathOf(el) {
    if (el.id && /^[A-Za-z_][\\w-]*$/.test(el.id) &&
        document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '//*[@id="' + el.id + '"]';
    }
    const segs = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body) {
      let i = 1;
      let s = n.previousElementSibling;
      while (s) { if (s.tagName === n.tagName) i++; s = s.previousElementSibling; }
      segs.unshift(n.tagName.toLowerCase() + '[' + i + ']');
      n = n.parentElement;
      if (segs.length > 8) break;
    }
    return '/' + segs.join('/');
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 80);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const id = lb.split(/\\s+/)[0];
      const ref = document.getElementById(id);
      if (ref && ref.textContent) return ref.textContent.trim().slice(0, 80);
    }
    const heading = el.querySelector('h1,h2,h3,[role="heading"]');
    if (heading && heading.textContent) return heading.textContent.trim().slice(0, 80);
    const txt = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    return txt.slice(0, 80);
  }

  function findButton(container, patterns) {
    const cands = container.querySelectorAll(
      'button, a, [role="button"], input[type="submit"], input[type="button"]'
    );
    for (const c of cands) {
      const text = ((c.textContent || '') + ' ' +
                    (c.getAttribute('aria-label') || '') + ' ' +
                    (c.getAttribute('value') || '')).toLowerCase().trim();
      if (!text) continue;
      for (const p of patterns) {
        if (p.test(text)) {
          return { el: c, text: text.replace(/\\s+/g, ' ').slice(0, 40) };
        }
      }
    }
    return null;
  }

  const ACCEPT = [
    /\\baccept(\\s+all)?\\b/, /\\bagree\\b/, /\\ballow(\\s+all)?\\b/,
    /^ok$/, /\\bgot it\\b/, /\\bcontinue\\b/, /\\bi understand\\b/,
    /\\bi consent\\b/, /^yes$/, /\\bsubscribe\\b/, /\\bsign\\s*up\\b/,
  ];
  const DISMISS = [
    /\\bdismiss\\b/, /\\bclose\\b/, /\\bcancel\\b/, /\\breject(\\s+all)?\\b/,
    /\\bdecline\\b/, /\\bno\\s*thanks?\\b/, /\\bskip\\b/, /\\bnot\\s+now\\b/,
    /\\bmaybe\\s+later\\b/, /×|✕|✖|⨯|✗/, /^x$/, /\\bno$/,
  ];

  const COOKIE_HINTS = /cookie|consent|gdpr|privacy|tracking|ot-sdk|onetrust|cookiebot/i;
  const NEWSLETTER_HINTS = /newsletter|subscribe|signup-form|email-capture|popup|exit-intent/i;

  const out = [];
  const seen = new Set();

  function pushObstruction(el, kind, z) {
    if (seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const accept = findButton(el, ACCEPT);
    const dismiss = findButton(el, DISMISS);
    out.push({
      kind: kind,
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: nameOf(el),
      xpath: xpathOf(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y),
              width: Math.round(r.width), height: Math.round(r.height) },
      acceptXPath: accept ? xpathOf(accept.el) : null,
      acceptText: accept ? accept.text : null,
      dismissXPath: dismiss ? xpathOf(dismiss.el) : null,
      dismissText: dismiss ? dismiss.text : null,
      zIndex: z,
    });
  }

  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (parseFloat(style.opacity || '1') === 0) continue;
    const z = parseInt(style.zIndex) || 0;
    pushObstruction(el, 'modal', z);
  }

  for (const el of document.querySelectorAll('div, section, aside, footer, header')) {
    if (seen.has(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (parseFloat(style.opacity || '1') === 0) continue;
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const z = parseInt(style.zIndex) || 0;

    const idClass = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
    const txt = (el.textContent || '').slice(0, 400);
    const looksCookie = COOKIE_HINTS.test(idClass) || (z >= 1 && /cookie|gdpr|consent|privacy/i.test(txt));
    const looksNewsletter = NEWSLETTER_HINTS.test(idClass) ||
                            (z >= 50 && /subscribe|newsletter|sign\\s*up/i.test(txt));
    const coversBig = (r.width * r.height) / vpArea > 0.25 && z >= 100;

    if (!looksCookie && !looksNewsletter && !coversBig) continue;
    pushObstruction(el, looksCookie ? 'cookie' : (looksNewsletter ? 'newsletter' : 'overlay'), z);
  }

  out.sort((a, b) => b.zIndex - a.zIndex);
  return out;
})`;
