// @vitest-environment happy-dom
//
// The card the user was told to click, and which never appeared.
//
// A session quarantined by a sensitive read blocked every later browser write.
// The recovery text said "click Declassify & retry on this blocked card" — and
// the UI decided clearability by matching layer names ('data-lineage' |
// 'tainted-shell'), while a kernel taint quarantine reports layer "arikernel"
// nested inside an "egress-aggregate". Correct words, unreachable control.
//
// These drive the REAL predicate and the REAL card builder against the exact
// metadata shapes the policy layer emits (egress-gates.ts blockerResult /
// renderEgressAggregate, enforce-policy.ts tainted-shell), so a future change to
// either side fails here instead of in a user's dead session.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Meta = Record<string, unknown>;
let isDeclassifiable: (md: Meta | undefined) => boolean;
let appendDeclassifyAction: (card: HTMLElement, sessionId: string) => void;
let isKernelBlockNotice: (md: Meta | undefined) => boolean;
let renderKernelBlockNotice: (endEvt: { name?: string; metadata?: Meta }, sessionId: string) => HTMLElement;

beforeAll(() => {
  const src = readFileSync(join(here, "../public/js/chat-declassify-action.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${src}\nreturn { isDeclassifiable, appendDeclassifyAction, isKernelBlockNotice, renderKernelBlockNotice };`);
  ({ isDeclassifiable, appendDeclassifyAction, isKernelBlockNotice, renderKernelBlockNotice } = factory());
});

beforeEach(() => {
  (globalThis as unknown as { apiPost: unknown }).apiPost = vi.fn(async () => ({ ok: true }));
  (globalThis as unknown as { esc: unknown }).esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
});

describe("isDeclassifiable — what the policy layer actually emits", () => {
  it("the kernel taint quarantine that started this (single blocker)", () => {
    // egress-gates.ts blockerResult() for the ARI kernel blocker.
    expect(isDeclassifiable({ layer: "arikernel", clearable: "declassify" })).toBe(true);
  });

  it("the same quarantine aggregated with other egress layers", () => {
    // renderEgressAggregate(): the authoritative layer is the aggregate, and
    // "arikernel" is only present inside `layers` — neither was ever matched.
    expect(isDeclassifiable({
      layer: "egress-aggregate",
      layers: ["arikernel", "egress-guard"],
      clearable: "declassify",
    })).toBe(true);
  });

  it("a data-lineage payload block", () => {
    expect(isDeclassifiable({ layer: "data-lineage", clearable: "declassify" })).toBe(true);
  });

  it("a tainted-shell block", () => {
    expect(isDeclassifiable({ layer: "tainted-shell", clearable: "declassify" })).toBe(true);
  });

  it("still honours legacy stored events that carry only a layer name", () => {
    expect(isDeclassifiable({ layer: "data-lineage" })).toBe(true);
    expect(isDeclassifiable({ layers: ["tainted-shell", "canary"] })).toBe(true);
  });

  it("does NOT offer a clear for blocks the user cannot clear", () => {
    // A canary is proof of exfiltration; a host-allowlist block is not a taint.
    expect(isDeclassifiable({ layer: "canary" })).toBe(false);
    expect(isDeclassifiable({ layer: "egress-guard", layers: ["egress-guard"] })).toBe(false);
    expect(isDeclassifiable({ layer: "egress-aggregate", layers: ["canary", "egress-guard"] })).toBe(false);
    expect(isDeclassifiable({})).toBe(false);
    expect(isDeclassifiable(undefined)).toBe(false);
  });
});

describe("appendDeclassifyAction — the card the user clicks", () => {
  const card = (): HTMLElement => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
  };

  it("renders a button labelled exactly as the recovery text names it", () => {
    const el = card();
    appendDeclassifyAction(el, "chat-abc");
    const btn = el.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("Declassify & retry");
  });

  it("posts the declassify to the server when clicked", () => {
    const el = card();
    appendDeclassifyAction(el, "chat-abc");
    el.querySelector("button")!.dispatchEvent(new Event("click"));
    const apiPost = (globalThis as unknown as { apiPost: ReturnType<typeof vi.fn> }).apiPost;
    expect(apiPost).toHaveBeenCalledWith("/api/security/declassify", expect.objectContaining({ sessionId: "chat-abc" }));
  });

  it("never stacks two cards on one blocked result", () => {
    const el = card();
    appendDeclassifyAction(el, "chat-abc");
    appendDeclassifyAction(el, "chat-abc");
    expect(el.querySelectorAll(".declassify-action").length).toBe(1);
  });

  it("renders nothing without a session to declassify", () => {
    const el = card();
    appendDeclassifyAction(el, "");
    expect(el.querySelector("button")).toBeNull();
  });
});

describe("the allow-host notice — a strict web-access block the user can lift", () => {
  // enforce-policy.ts stamps these from the BlockAction; egress-gates.ts keeps
  // them through the single-blocker and aggregate results.
  const single = { layer: "security", clearable: "allow-host", host: "docs.example.org" };
  const aggregate = { layer: "egress-aggregate", layers: ["arikernel", "security"], clearable: "allow-host", host: "docs.example.org" };

  it("warrants the notice, but is not a declassify", () => {
    expect(isKernelBlockNotice(single)).toBe(true);
    expect(isKernelBlockNotice(aggregate)).toBe(true);
    expect(isDeclassifiable(single)).toBe(false);
    // The flag without a host is nothing to click.
    expect(isKernelBlockNotice({ layer: "security", clearable: "allow-host" })).toBe(false);
  });

  it("renders the host and one button that allows it and retries", () => {
    const el = renderKernelBlockNotice({ name: "web_fetch", metadata: single }, "s1");
    expect(el.querySelector(".kernel-block-text")?.textContent).toContain("docs.example.org is not on your allowed sites");
    expect(el.querySelectorAll(".allow-host-action")).toHaveLength(1);
    expect(el.querySelector(".declassify-action")).toBeNull();
    const btn = el.querySelector("button") as HTMLButtonElement;
    expect(btn.textContent).toBe("Allow docs.example.org & retry");
    btn.click();
    expect((globalThis as unknown as { apiPost: ReturnType<typeof vi.fn> }).apiPost)
      .toHaveBeenCalledWith("/api/security/egress", { allow: "docs.example.org" });
  });

  it("a declassify-and-host aggregate offers declassify first, never two buttons", () => {
    const el = renderKernelBlockNotice({ name: "http_request", metadata: { ...aggregate, clearable: "declassify" } }, "s1");
    expect(el.querySelectorAll("button")).toHaveLength(1);
    expect(el.querySelector(".declassify-action")).not.toBeNull();
  });
});
