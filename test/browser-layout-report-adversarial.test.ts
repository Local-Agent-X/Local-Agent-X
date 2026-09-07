// @vitest-environment happy-dom
/**
 * The two invariants of the layout diagnostic script, proven against a page
 * that owns every global the script reads.
 *
 * INVARIANT 1 — the value the script returns is valid JSON of at most
 * LAYOUT_REPORT_MAX_CHARS chars, for any page. A seeded fuzz: each iteration
 * randomizes the page-controlled inputs across a hostile set (backslash,
 * control-char, invisible, homoglyph and surrogate strings up to 20k chars in
 * url / userAgent / ids / classes / text / media conditions / background
 * colours; innerWidth as a 9k string; getComputedStyle replaced by a proxy;
 * maxTouchPoints NaN; 0-300 overflowing, 0-50 fixed, 0-50 media conditions;
 * the scan, rule, depth and list caps) and runs the script through the REAL
 * evaluateScript. Then a batch at a reduced budget, where the fallback
 * document is reachable, and a page whose global throws.
 *
 * INVARIANT 2 — the untrusted-content wrapper cannot change the parsed
 * document. A page whose labels and ids carry the wrapper's own trigger
 * strings round-trips through the handler and the real wrapper to the same
 * bytes; and for every UTF-16 code unit, the script's one-char literal is a
 * fixed point of the wrapper's pure edit steps.
 *
 * Seed: LAYOUT_FUZZ_SEED in the environment, else DEFAULT_SEED. A failure
 * names the seed and the iteration.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  buildLayoutReportScript, LAYOUT_REPORT_JSON_ESCAPE, LAYOUT_REPORT_KNOWN_GAPS, LAYOUT_REPORT_LIST_CAP,
  LAYOUT_REPORT_MAX_CHARS, LAYOUT_REPORT_RULE_CAP, LAYOUT_REPORT_RULE_DEPTH, LAYOUT_REPORT_SCAN_CAP, LAYOUT_REPORT_SCRIPT,
} from "../src/browser/layout-report.js";
import { evaluateScript } from "../src/browser/page-ops.js";
import { handleLayoutReport } from "../src/tools/browser-tools/layout-report.js";
import type { BrowserBackend } from "../src/browser/backend.js";
import { normalizeHomoglyphs, stripControlChars, stripSystemInjectionTags } from "../src/sanitize.js";

const DEFAULT_SEED = 0x5eed2026;
const SEED = Number(process.env.LAYOUT_FUZZ_SEED) || DEFAULT_SEED;
const ITERATIONS = 300;
const REDUCED_CAP = 3_000;
const REDUCED_ITERATIONS = 60;
const VIEWPORT = 390;

/** Flags and totals a reader needs before trusting any count. */
const FLAG_KEYS = [
  "urlTruncated", "nonNumericFields", "listsTrimmedForSize", "overflowingElementsTotal", "overflowingElementsListed",
  "fixedAndStickyTotal", "fixedAndStickyListed", "matchingMediaQueriesTotal", "matchingMediaQueriesListed",
  "unreadableStyleSheets", "unreadableRules", "unloadedImports", "unevaluableMediaConditions", "cssRulesTruncated",
  "cssDepthTruncated", "disabledSheetsSkipped", "sheetsSkippedByMedia", "cssWalkIncomplete", "elementsScanned",
  "scanTruncated", "hiddenElementsSkipped", "zeroSizeElementsSkipped", "openShadowRoots", "iframes", "sameOriginIframes",
  "elementScanIncomplete", "knownGaps",
];

/** mulberry32 — a small seeded PRNG, so a failing iteration is reproducible. */
function rngFor(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces the hostile strings are built from: what JSON must escape, what
 *  the wrapper strips or normalizes, surrogates (paired and lone), JSON
 *  structure chars, and plain text. */
const ATOMS = [
  "\\", "\"", "\\\\", "\\u003c", "\u0000", "\u0001", "\u001f", "\u007f", "\u0085", "\u009f",
  "\u200b", "\u200c", "\u200d", "\u200e", "\ufeff", "\u2060", "\u2063", "\u00ad", "\u034f", "\u180e",
  "\uff1c", "\uff1e", "\ufe64", "\u2329", "\u27e8", "\u3008", "\u276c", "\u2770", "\ufe3b", "\uff08", "\uff3b", "\u27e6",
  "\u2028", "\u2029", "\ud83d\ude00", "\ud800", "\udfff", "é", "日本",
  "<system>", "</system>", "<system-reminder>", "</system-reminder>", "<|im_start|>", "<|", "|>", "<human>", "</assistant>",
  "<<<EXTERNAL", "<<<END_EXTERNAL", "<<<UNTRUSTED", "[[MARKER_SANITIZED]]", "[CONTENT-STRIPPED]",
  "<", ">", "[", "]", "{", "}", ",", ":", "\n", "\r", "\t", " ", "a", "Z", "0", "Mozilla/5.0 ", "rgb(1, 2, 3)",
];

function hostile(rng: () => number, maxLen: number): string {
  const r = rng();
  const len = Math.floor(rng() * (r < 0.3 ? Math.min(maxLen, 50) : r < 0.8 ? Math.min(maxLen, 2000) : maxLen));
  let out = "";
  while (out.length < len) out += ATOMS[Math.floor(rng() * ATOMS.length)];
  return out.slice(0, len);
}

const media = (mediaText: string, children: unknown[] = []) => ({ media: { mediaText }, cssRules: children });
const group = (children: unknown[]) => ({ cssRules: children });

function box(el: Element): DOMRect {
  const raw = (el as HTMLElement).dataset?.rect;
  const [x, y, width, height] = raw ? raw.split(",").map(Number) : [0, 0, 100, 20];
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height } as DOMRect;
}

const page = { evaluate: async (expression: string) => (0, eval)(expression) } as unknown as Page;

type Restore = () => void;
const restores: Restore[] = [];
function override(host: object, key: string, value: unknown): void {
  const desc = Object.getOwnPropertyDescriptor(host, key);
  Object.defineProperty(host, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (desc) Object.defineProperty(host, key, desc); else delete (host as Record<string, unknown>)[key];
  });
}

interface Shape { overflowing: number; fixed: number; mediaCount: number; scanCapped: boolean }

/** Builds one hostile page and installs the hostile globals. Returns what
 *  was built, for the summary. */
function buildHostilePage(rng: () => number): Shape {
  const shape: Shape = {
    overflowing: Math.floor(rng() * 301),
    fixed: Math.floor(rng() * 51),
    mediaCount: Math.floor(rng() * 51),
    scanCapped: rng() < 0.04,
  };
  const body = document.body;
  body.innerHTML = "";
  const add = (tag: string, kind: string, rect: string, i: number) => {
    const el = document.createElement(tag);
    el.dataset.kind = kind;
    el.dataset.rect = rng() < 0.05 ? "x,y,z,w" : rect;
    if (rng() < 0.5) el.id = hostile(rng, 20_000); else el.className = `${hostile(rng, 20_000)} ${hostile(rng, 200)}`;
    el.textContent = hostile(rng, 20_000);
    if (rng() < 0.2) {
      const child = document.createElement("span");
      child.textContent = hostile(rng, 5_000);
      el.append(child);
    }
    body.append(el);
    return i;
  };
  for (let i = 0; i < shape.overflowing; i++) add("div", "over", `${rng() < 0.2 ? -50 : 0},${i * 20},${400 + Math.floor(rng() * 20_000)},20`, i);
  for (let i = 0; i < shape.fixed; i++) add("nav", "fixed", `0,${i * 20},${VIEWPORT},20`, i);
  if (shape.scanCapped) {
    const filler = document.createDocumentFragment();
    for (let i = 0; i < LAYOUT_REPORT_SCAN_CAP + 10; i++) filler.append(document.createElement("i"));
    body.append(filler);
  }
  // getComputedStyle is the page's: a proxy whose every property is page text,
  // with display/position set so the rows above are measured and classified.
  const kinds = ["over", "fixed", "filler"];
  override(globalThis, "getComputedStyle", (el: Element) => {
    const kind = (el as HTMLElement).dataset?.kind ?? "root";
    return new Proxy({}, {
      get: (_t, key) => {
        if (key === "display") return rng() < 0.03 && kinds.includes(kind) ? "none" : rng() < 0.5 ? "block" : hostile(rng, 100);
        if (key === "visibility") return rng() < 0.03 ? "hidden" : "visible";
        if (key === "position") return kind === "fixed" ? (rng() < 0.5 ? "fixed" : "sticky") : rng() < 0.9 ? "static" : hostile(rng, 5_000);
        return hostile(rng, 20_000);
      },
    });
  });
  // Stylesheets: hostile conditions (some sharing a long prefix), plus the
  // walk's own edge cases and caps.
  const conditions: string[] = [];
  const prefix = hostile(rng, 300);
  for (let i = 0; i < shape.mediaCount; i++) conditions.push(rng() < 0.3 ? prefix + hostile(rng, 50) : hostile(rng, 20_000));
  const sheets: unknown[] = [group(conditions.map((c) => media(c)))];
  if (rng() < 0.3) sheets.push({ disabled: true, cssRules: [media(hostile(rng, 100))] });
  if (rng() < 0.3) sheets.push({ media: { mediaText: hostile(rng, 3_000) }, cssRules: [media("(max-width: 1px)")] });
  if (rng() < 0.3) sheets.push({ get cssRules(): unknown { throw new Error("SecurityError"); } });
  if (rng() < 0.3) sheets.push(null, group([null]));
  if (rng() < 0.3) sheets.push(group([{ href: "https://cdn.example.com/x.css", styleSheet: null, media: { mediaText: hostile(rng, 500) } }]));
  if (rng() < 0.1) sheets.push(group(Array.from({ length: LAYOUT_REPORT_RULE_CAP + 1 }, () => group([]))));
  if (rng() < 0.1) {
    let node: unknown = media("(max-width: 1px)");
    for (let i = 0; i < LAYOUT_REPORT_RULE_DEPTH + 3; i++) node = group([node]);
    sheets.push(node);
  }
  override(document, "styleSheets", sheets);
  override(globalThis, "matchMedia", (q: string) => {
    if (rng() < 0.05) throw new Error("SyntaxError");
    return { matches: rng() < 0.7, media: q };
  });
  // The scalars the page owns.
  override(globalThis, "location", { href: hostile(rng, 20_000) });
  override(navigator, "userAgent", hostile(rng, 20_000));
  override(navigator, "maxTouchPoints", rng() < 0.5 ? NaN : hostile(rng, 100));
  override(globalThis, "innerWidth", rng() < 0.5 ? "9".repeat(9_000) : hostile(rng, 9_000));
  override(globalThis, "innerHeight", rng() < 0.5 ? Infinity : 844);
  override(globalThis, "devicePixelRatio", rng() < 0.5 ? hostile(rng, 1_000) : 2);
  override(document.documentElement, "clientWidth", rng() < 0.2 ? hostile(rng, 5_000) : VIEWPORT);
  override(document.documentElement, "clientHeight", 844);
  override(document.documentElement, "scrollWidth", rng() < 0.2 ? "wide" : 500);
  return shape;
}

interface Outcome { text: string; fallback: boolean }

/** One iteration: build, run through the real evaluateScript, assert the
 *  invariant for the given budget. */
async function fuzzOnce(seed: number, iteration: number, script: string, cap: number): Promise<Outcome> {
  const rng = rngFor(seed + iteration * 7919);
  buildHostilePage(rng);
  try {
    const text = await evaluateScript(page, script);
    try {
      expect(text).not.toContain("[Truncated at");
      expect(text.length).toBeLessThanOrEqual(cap);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.reportFailed).toBeUndefined();
      if (parsed.reportTooLarge === true) {
        expect(parsed.bytesBeforeFallback).toBeGreaterThan(cap);
        expect(parsed.knownGaps).toEqual([...LAYOUT_REPORT_KNOWN_GAPS]);
        return { text, fallback: true };
      }
      for (const key of FLAG_KEYS) expect(parsed).toHaveProperty(key);
      for (const key of ["overflowingElements", "fixedAndStickyElements", "matchingMediaQueries"]) {
        expect((parsed[key] as unknown[]).length).toBeLessThanOrEqual(LAYOUT_REPORT_LIST_CAP);
      }
      return { text, fallback: false };
    } catch (e) {
      throw new Error(`layout_report fuzz failed at seed=${seed} iteration=${iteration} (LAYOUT_FUZZ_SEED=${seed} reproduces): ${(e as Error).message}`);
    }
  } finally {
    for (const undo of restores.splice(0).reverse()) undo();
  }
}

async function fuzzBatch(script: string, cap: number, iterations: number, label: string): Promise<{ fallbacks: number; maxSize: number }> {
  let fallbacks = 0;
  let maxSize = 0;
  for (let i = 0; i < iterations; i++) {
    const outcome = await fuzzOnce(SEED, i, script, cap);
    if (outcome.fallback) fallbacks++;
    maxSize = Math.max(maxSize, outcome.text.length);
  }
  console.info(`layout_report fuzz [${label}]: seed=${SEED} iterations=${iterations} cap=${cap} maxSize=${maxSize} fallbackHits=${fallbacks}`);
  return { fallbacks, maxSize };
}

beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.adoptedStyleSheets = [];
  Element.prototype.getBoundingClientRect = function () { return box(this); };
  for (const [prop, value] of [["clientWidth", VIEWPORT], ["clientHeight", 844]] as const) {
    Object.defineProperty(document.documentElement, prop, { value, configurable: true });
  }
});

afterEach(() => {
  for (const undo of restores.splice(0).reverse()) undo();
});

describe("invariant 1: valid JSON under the budget, for any page", () => {
  it(`${ITERATIONS} hostile pages through the real evaluateScript at the shipped budget`, async () => {
    const { maxSize } = await fuzzBatch(LAYOUT_REPORT_SCRIPT, LAYOUT_REPORT_MAX_CHARS, ITERATIONS, "shipped");

    expect(maxSize).toBeLessThanOrEqual(LAYOUT_REPORT_MAX_CHARS);
  }, 120_000);

  // At the shipped budget the capped scalars sum to less than the budget, so
  // the fallback is not reached there; at a reduced budget it is, and this
  // batch is what goes red when the final guard is removed.
  it(`${REDUCED_ITERATIONS} hostile pages at a reduced budget reach the reportTooLarge fallback and stay under it`, async () => {
    const { fallbacks } = await fuzzBatch(buildLayoutReportScript(REDUCED_CAP), REDUCED_CAP, REDUCED_ITERATIONS, "reduced");

    expect(fallbacks).toBeGreaterThan(0);
  }, 60_000);

  it("the fallback document carries the url cut to its own cap, and the pre-fallback size", async () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">x</p>`;
    override(globalThis, "location", { href: "https://shop.example.com/" + "u".repeat(3_000) });

    const text = await evaluateScript(page, buildLayoutReportScript(REDUCED_CAP));
    const parsed = JSON.parse(text) as { reportTooLarge: boolean; bytesBeforeFallback: number; url: string; knownGaps: string[] };

    expect(text.length).toBeLessThanOrEqual(REDUCED_CAP);
    expect(parsed.reportTooLarge).toBe(true);
    expect(parsed.bytesBeforeFallback).toBeGreaterThan(REDUCED_CAP);
    expect(JSON.stringify(parsed.url)).toHaveLength(256);
    expect(parsed.knownGaps).toEqual([...LAYOUT_REPORT_KNOWN_GAPS]);
  });

  it("a page global that throws yields the reportFailed document, still valid JSON under the budget", async () => {
    document.body.innerHTML = `<p data-rect="0,0,390,20">x</p>`;
    override(globalThis, "getComputedStyle", () => { throw new Error("the page's getComputedStyle refuses <" + "x".repeat(2_000)); });

    const text = await evaluateScript(page, LAYOUT_REPORT_SCRIPT);
    const parsed = JSON.parse(text) as { reportFailed: boolean; error: string; knownGaps: string[] };

    expect(text).not.toContain("[Truncated at");
    expect(text.length).toBeLessThanOrEqual(LAYOUT_REPORT_MAX_CHARS);
    expect(parsed.reportFailed).toBe(true);
    expect(parsed.error).toMatch(/^the page's getComputedStyle refuses </);
    expect(JSON.stringify(parsed.error).length).toBeLessThanOrEqual(256);
    expect(parsed.knownGaps).toEqual([...LAYOUT_REPORT_KNOWN_GAPS]);
  });
});

/** The bytes inside the untrusted-content wrapper's <content> block. */
function payload(text: string): string {
  const open = text.indexOf("<content>\n");
  const close = text.indexOf("\n</content>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return text.slice(open + "<content>\n".length, close);
}

describe("invariant 2: the wrapper cannot change the parsed document", () => {
  const TRIGGERS = [
    // The first LIST_CAP go into ids (the selector), so the members of JS \s
    // (U+2028, U+FEFF) survive the label's whitespace collapse.
    "<system>", "</system>", "<system-reminder>x</system-reminder>", "<|im_start|>", "<|", "\u2028", "\u200b", "\u200d", "\ufeff", "\u00ad",
    "\uff1c", "\uff1e", "\u2329", "\u27e8", "\uff08", "\uff3b", "[CONTENT-STRIPPED]", "[[MARKER_SANITIZED]]", "<<<EXTERNAL", "<<<END_EXTERNAL",
    "|>", "\u0001", "\u007f", "\u0085",
  ];

  it("a page carrying the wrapper's trigger strings in ids, classes, labels and media text round-trips byte-for-byte through the handler", async () => {
    document.body.innerHTML = "";
    // Two triggers per overflowing row (in the id, which is the selector, and
    // in the text) for the first LIST_CAP triggers — few enough rows that the
    // size trim does not run; the rest ride in fixed rows, after the split
    // <system> / </system> pair.
    const overRows = Array.from({ length: LAYOUT_REPORT_LIST_CAP / 2 }, (_, i) => TRIGGERS[2 * i] + "+" + TRIGGERS[2 * i + 1]);
    const fixedRows = ["<system>", "</system>", ...TRIGGERS.slice(LAYOUT_REPORT_LIST_CAP)];
    expect(fixedRows.length).toBeLessThanOrEqual(LAYOUT_REPORT_LIST_CAP);
    overRows.forEach((trigger, i) => {
      const el = document.createElement("div");
      el.dataset.rect = `0,${i * 20},600,20`;
      el.id = `id-${trigger}-${i}`;
      el.textContent = `label ${trigger} tail`;
      document.body.append(el);
    });
    fixedRows.forEach((trigger, i) => {
      const el = document.createElement("nav");
      el.dataset.rect = `0,${i * 20},390,20`;
      el.style.position = "fixed";
      el.textContent = trigger;
      document.body.append(el);
    });
    override(document, "styleSheets", [group([media("(max-width: 767px) and <system>"), media("</system> (min-width: 1px)")])]);
    override(globalThis, "matchMedia", (q: string) => ({ matches: true, media: q }));
    override(globalThis, "location", { href: "https://shop.example.com/<system>?x=\u200b" });
    override(navigator, "userAgent", "Mozilla/5.0 <|im_start|> \uff1cb\uff1e");

    const raw = await evaluateScript(page, LAYOUT_REPORT_SCRIPT);
    const backend = { getCurrentUrl: () => "https://shop.example.com/", evaluate: (script: string) => evaluateScript(page, script) } as unknown as BrowserBackend;
    const result = await handleLayoutReport(backend);
    const unwrapped = payload(String(result.content));

    expect(result.isError).not.toBe(true);
    expect(unwrapped).toBe(raw);
    expect(JSON.parse(unwrapped)).toEqual(JSON.parse(raw));
    // The document really carried the triggers: they are in the parsed values.
    const parsed = JSON.parse(raw) as {
      url: string; viewport: { userAgent: string }; listsTrimmedForSize: boolean;
      overflowingElements: { selector: string; selectorTruncated?: true; text: string }[]; fixedAndStickyElements: { text: string }[]; matchingMediaQueries: string[];
    };
    expect(parsed.listsTrimmedForSize).toBe(false);
    expect(parsed.overflowingElements).toHaveLength(overRows.length);
    for (const row of parsed.overflowingElements) expect(row.selectorTruncated).toBeUndefined();
    const texts = parsed.overflowingElements.map((r) => r.selector + " " + r.text).join("\n");
    for (const trigger of TRIGGERS.slice(0, LAYOUT_REPORT_LIST_CAP)) expect(texts).toContain(trigger);
    expect(parsed.fixedAndStickyElements.map((r) => r.text)).toEqual(fixedRows);
    expect(parsed.matchingMediaQueries).toEqual(["(max-width: 767px) and <system>", "</system> (min-width: 1px)"]);
    expect(parsed.url).toBe("https://shop.example.com/<system>?x=\u200b");
    expect(parsed.viewport.userAgent).toBe("Mozilla/5.0 <|im_start|> \uff1cb\uff1e");
    // And the bytes carry none of them.
    for (const trigger of TRIGGERS) expect(raw).not.toContain(trigger);
  });

  it("for every UTF-16 code unit, the script's one-char literal is a fixed point of the wrapper's edit steps", () => {
    const hex4 = (ch: string) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    const literal = (s: string) => JSON.stringify(s).replace(LAYOUT_REPORT_JSON_ESCAPE, hex4);
    const edited: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const lit = literal(String.fromCharCode(code));
      if (normalizeHomoglyphs(stripSystemInjectionTags(stripControlChars(lit))) !== lit) edited.push(`U+${code.toString(16).padStart(4, "0")}`);
      if (JSON.parse(lit) !== String.fromCharCode(code)) edited.push(`U+${code.toString(16).padStart(4, "0")} does not parse back`);
    }
    expect(edited).toEqual([]);
  });

  it("the shipped script is the builder at the shipped budget", () => {
    expect(LAYOUT_REPORT_SCRIPT).toBe(buildLayoutReportScript());
    expect(LAYOUT_REPORT_SCRIPT).toContain(`const MAX_CHARS = ${LAYOUT_REPORT_MAX_CHARS};`);
  });
});
