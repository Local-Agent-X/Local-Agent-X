/**
 * `compare_pages` — fetch two URLs as BOTH a desktop and a phone, and report
 * how the two origins differ structurally.
 *
 * The task this exists for is "make our page match theirs". That job has a
 * failure mode the harness had no answer for: the agent compares screenshots,
 * decides the CSS is close but wrong, and patches an override stylesheet
 * forever. It ran 76 turns that way once. What no screenshot can show is that
 * the two origins BUILD their mobile page differently — one serving a separate
 * mobile document, the other serving desktop markup with overrides bolted on.
 * Those never converge by tuning CSS, and the check that reveals it is two
 * fetches with two user agents, not a rendering pass.
 *
 * Network goes through canonicalFetch (web-egress.ts) — the one hardened,
 * SSRF-pinned fetch — so this adds no second egress path. The desktop UA is
 * web-egress's BROWSER_USER_AGENT and the phone UA is the iphone emulation
 * preset, so this tool and `browser {action:"emulate"}` claim to be the same
 * phone.
 *
 * It states NO verdict — see page-structure.ts. It returns numbers and lists.
 */
import type { ToolDefinition } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import { ok, err } from "./result-helpers.js";
import { canonicalFetch, BROWSER_USER_AGENT, BROWSER_ACCEPT_LANGUAGE } from "./web-egress.js";
import { EMULATION_PRESETS } from "../browser/emulation.js";
import { comparePages, type SideInput } from "./page-structure.js";

const MOBILE_USER_AGENT = EMULATION_PRESETS.iphone.userAgent;

/** Per-response body ceiling. Four fetches, so this bounds the whole call at
 *  ~8 MB of HTML held at once; the structures extracted from it are small. */
const MAX_HTML_BYTES = 2_000_000;
/** Headings echoed back per list. A page with more than this is pathological
 *  and the point is made by the first few either way. */
const MAX_LISTED = 40;

async function fetchAs(url: string, userAgent: string, signal?: AbortSignal): Promise<string> {
  const res = await canonicalFetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": BROWSER_ACCEPT_LANGUAGE,
      // A phone UA with sec-ch-ua-mobile:?0 is a contradiction some CDNs read
      // before the UA string, and device-specific delivery is exactly what is
      // being measured — so this hint has to agree with the UA.
      "sec-ch-ua-mobile": userAgent === MOBILE_USER_AGENT ? "?1" : "?0",
      "Upgrade-Insecure-Requests": "1",
    },
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (signal?.aborted) throw new Error("aborted");
  return body.length > MAX_HTML_BYTES ? body.slice(0, MAX_HTML_BYTES) : body;
}

async function loadSide(url: string, signal?: AbortSignal): Promise<SideInput> {
  const [desktopHtml, mobileHtml] = await Promise.all([
    fetchAs(url, BROWSER_USER_AGENT, signal),
    fetchAs(url, MOBILE_USER_AGENT, signal),
  ]);
  return { url, desktopHtml, mobileHtml };
}

function cap(list: string[]): string[] {
  return list.length > MAX_LISTED ? list.slice(0, MAX_LISTED) : list;
}

export const comparePagesTool: ToolDefinition = {
  name: "compare_pages",
  compactDescription:
    "Compare two URLs structurally, as both desktop and phone. Use FIRST on any \"make X match Y\" task — it shows whether the two origins deliver mobile the same way before you touch CSS.",
  effect: { class: "read-only" },
  description:
    "Fetch two URLs with a desktop and a phone user agent each, and report how they differ structurally: how much each origin's phone document differs from its own desktop document, which headings each phone document has that the other does not, and which stylesheets each phone document loads. Use this BEFORE editing CSS on a \"make our page match theirs\" task: if one origin serves a separate mobile document and the other serves desktop markup, no stylesheet change will make them converge, and no screenshot shows it. Reports measurements only — it states no verdict about whether the pages match.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "string", description: "First URL (e.g. your clone)" },
      b: { type: "string", description: "Second URL (e.g. the original being matched)" },
    },
    required: ["a", "b"],
  },
  async execute(args, signal?: AbortSignal) {
    const aUrl = String(args.a ?? "");
    const bUrl = String(args.b ?? "");
    if (!aUrl || !bUrl) return err("compare_pages needs both `a` and `b` URLs.");

    let sideA: SideInput;
    let sideB: SideInput;
    try {
      sideA = await loadSide(aUrl, signal);
    } catch (e) {
      return err(`Could not fetch a (${aUrl}): ${(e as Error).message}`);
    }
    try {
      sideB = await loadSide(bUrl, signal);
    } catch (e) {
      return err(`Could not fetch b (${bUrl}): ${(e as Error).message}`);
    }

    const report = comparePages(sideA, sideB);
    const payload = {
      ...report,
      a: {
        ...report.a,
        headingsDroppedOnMobile: cap(report.a.headingsDroppedOnMobile),
        headingsAddedOnMobile: cap(report.a.headingsAddedOnMobile),
        mobileHeadings: cap(report.a.mobileHeadings),
      },
      b: {
        ...report.b,
        headingsDroppedOnMobile: cap(report.b.headingsDroppedOnMobile),
        headingsAddedOnMobile: cap(report.b.headingsAddedOnMobile),
        mobileHeadings: cap(report.b.mobileHeadings),
      },
      headingsOnlyInA: cap(report.headingsOnlyInA),
      headingsOnlyInB: cap(report.headingsOnlyInB),
    };

    // Heading text and stylesheet hrefs are bytes the fetched pages control, so
    // the whole document goes through the untrusted-content wrapper — same
    // treatment web_fetch gives a page body.
    return ok(wrapExternalContent(JSON.stringify(payload, null, 2), "compare_pages"));
  },
};
