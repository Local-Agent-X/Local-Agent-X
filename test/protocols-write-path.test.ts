/**
 * Protocol write-path invariants.
 *
 * These pin behaviour that a background authoring fork depends on and that a
 * single-writer, never-edit-in-place world never exercised:
 *   - an in-place EDIT is discoverable by protocol(action:'search')
 *   - authorProtocol() stamps provenance and persists a markdown body
 *   - the dedup gate is one implementation, reachable from both the tool and
 *     the programmatic path
 *   - an edit invalidates the cached dedup embedding, and the invalidation
 *     survives a concurrent embedding refresh
 *   - every catalog file is replaced atomically, never written in place
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Record every fs write/rename so the atomicity CONTRACT can be asserted:
// payload lands on a temp path and is renamed onto the destination, so the
// destination is never observed partially written. Both implementations are
// the real ones — this observes, it does not stub.
// `failReaddir` additionally lets a test make one directory unreadable, which
// is what an EBUSY/EPERM from a git sync or an AV scan looks like to the
// loader — the input that must NOT be mistaken for "the user deleted these".
const fsSpy = vi.hoisted(() => ({
  writes: [] as string[],
  renames: [] as Array<{ from: string; to: string }>,
  failReaddir: new Set<string>(),
  failStat: new Set<string>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    writeFileSync(path: Parameters<typeof actual.writeFileSync>[0], data: Parameters<typeof actual.writeFileSync>[1], opts?: Parameters<typeof actual.writeFileSync>[2]) {
      fsSpy.writes.push(String(path));
      return actual.writeFileSync(path, data, opts);
    },
    renameSync(from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) {
      fsSpy.renames.push({ from: String(from), to: String(to) });
      return actual.renameSync(from, to);
    },
    readdirSync(path: Parameters<typeof actual.readdirSync>[0], opts?: Parameters<typeof actual.readdirSync>[1]) {
      if (fsSpy.failReaddir.has(String(path))) {
        const err = new Error(`EBUSY: resource busy or locked, scandir '${String(path)}'`) as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return actual.readdirSync(path, opts as never);
    },
    statSync(path: Parameters<typeof actual.statSync>[0], opts?: Parameters<typeof actual.statSync>[1]) {
      // Same fault class as failReaddir, one level down: the directory listed
      // fine but one entry couldn't be stat'd (EPERM on a locked dir, a broken
      // junction, a dir deleted between readdir and stat). The protocol behind
      // it silently vanishes from the catalog.
      if (fsSpy.failStat.has(String(path))) {
        const err = new Error(`EPERM: operation not permitted, stat '${String(path)}'`) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return actual.statSync(path, opts as never);
    },
  };
});

import { setRuntimeConfig, getRuntimeConfig } from "../src/config.js";
import type { LAXConfig } from "../src/types.js";
import {
  createProtocol, editProtocol, saveCustomProtocols, loadCustomProtocols, authorProtocol,
  createBuilderTools,
} from "../src/protocols/builder.js";
import { archiveProtocol, loadArchived, unarchiveProtocol } from "../src/protocols/archive.js";
import { createProtocolSearchTool } from "../src/protocols/search.js";
import { dropEmbedding, findCatalogDuplicate } from "../src/protocols/dedup.js";
import {
  bundledProtocolsDir, invalidateBundledCache, loadBundledProtocols,
  catalogReadFailureCount, importedProtocolsDir, loadImportedProtocols,
} from "../src/protocols/loader.js";
import { getAllProtocols } from "../src/protocols/index.js";
import { setEmbeddingProviderSingleton } from "../src/embedding-singleton.js";
import type { ExtendedEmbeddingProvider } from "../src/embedding-providers/types.js";
import type { Protocol } from "../src/protocols/types.js";

let TEMP: string;
let TEMP_LAX: string;
let ORIGINAL_CFG: LAXConfig;
let ORIGINAL_LAX_DATA_DIR: string | undefined;

/** Deterministic bag-of-words embedder. Real enough that near-paraphrases land
 *  above the 0.85 cosine gate and unrelated text lands near zero, with no
 *  network and no model. Named "local" so isLocalOnlyMode() can't filter it. */
const DIMS = 64;
function bagOfWords(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % DIMS] += 1;
  }
  return v;
}

// A gate on embed() so a dedup pass can be parked mid-`await` — the window in
// which a concurrent writer's dropEmbedding() lands. Closed by default.
let embedGate: Promise<void> | null = null;
let releaseGate: (() => void) | null = null;
const embedLog: string[] = [];
function openEmbedGate(): void {
  embedGate = new Promise<void>((resolve) => { releaseGate = resolve; });
}
function releaseEmbedGate(): void {
  const r = releaseGate;
  embedGate = null;
  releaseGate = null;
  r?.();
}
/** Spin until the parked pass has entered at least `n` embed calls. */
async function waitForEmbeds(n: number): Promise<void> {
  for (let i = 0; i < 500 && embedLog.length < n; i++) await new Promise((r) => setTimeout(r, 1));
}

const fakeProvider: ExtendedEmbeddingProvider = {
  name: "local",
  model: "test-bag-of-words",
  dimensions: DIMS,
  maxBatchSize: 8,
  async embed(text: string) {
    embedLog.push(text);
    if (embedGate) await embedGate;
    return bagOfWords(text);
  },
  async embedBatch(texts: string[]) { return texts.map(bagOfWords); },
  async embedQuery(text: string) { return bagOfWords(text); },
};

beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-writepath-test-"));
  ORIGINAL_CFG = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP } as LAXConfig);

  // Pin the LAX data dir. getAllProtocols() reaches the loader, which runs the
  // legacy migrations by renameSync-ing ~/.lax/skills and
  // ~/.lax/protocols/imported INTO the workspace — here a temp dir afterAll
  // deletes. Unpinned, this suite would destroy the user's real imported
  // protocols. Pinning also makes the merged catalog deterministic.
  TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-writepath-test-laxdir-"));
  ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = TEMP_LAX;

  setEmbeddingProviderSingleton(fakeProvider);
});

beforeEach(() => {
  saveCustomProtocols([]);
  for (const f of ["archived.json", "usage.jsonl", "embeddings.json"]) {
    const p = join(TEMP, "protocols", f);
    if (existsSync(p)) rmSync(p);
  }
  releaseEmbedGate();
  embedLog.length = 0;
  fsSpy.writes.length = 0;
  fsSpy.renames.length = 0;
  fsSpy.failReaddir.clear();
  fsSpy.failStat.clear();
  if (existsSync(importedProtocolsDir())) rmSync(importedProtocolsDir(), { recursive: true, force: true });
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CFG);
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  rmSync(TEMP, { recursive: true, force: true });
  rmSync(TEMP_LAX, { recursive: true, force: true });
});

function mkProtocol(name: string, extra: Partial<Protocol> = {}): Protocol {
  return {
    name,
    description: `${name} description`,
    triggers: [name],
    steps: [{ id: "s1", instruction: "do thing" }],
    rules: [],
    learnablePreferences: [],
    ...extra,
  };
}

const search = createProtocolSearchTool();
async function searchFor(query: string): Promise<string> {
  const res = await search.execute({ query, limit: 25 });
  return String(res.content);
}

/** Let the fire-and-forget dedup-cache maintenance in editProtocol land. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function writeEmbeddingCache(entries: Record<string, string>): void {
  const dir = join(TEMP, "protocols");
  mkdirSync(dir, { recursive: true });
  const cache: Record<string, { vec: number[]; textHash: string }> = {};
  for (const [name, hash] of Object.entries(entries)) cache[name] = { vec: [1, 0, 0], textHash: hash };
  writeFileSync(join(dir, "embeddings.json"), JSON.stringify(cache), "utf-8");
}

function readEmbeddingCache(): Record<string, unknown> {
  const p = join(TEMP, "protocols", "embeddings.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
}

describe("search index sees in-place edits (F1)", () => {
  it("surfaces a protocol under keywords added by an edit, and drops the old ones", async () => {
    // The catalog COUNT never changes across the edit — that was the only
    // thing the index keyed off, so a reworded protocol stayed invisible for
    // the whole process lifetime. This is the regression that makes an
    // autonomous PATCH silently useless.
    createProtocol(mkProtocol("idx-target", {
      description: "handles widget assembly",
      triggers: ["assemble widget"],
    }));

    // Build the index while the old wording is live.
    const before = await searchFor("widget");
    expect(before).toContain("idx-target");

    const countBefore = loadCustomProtocols().length;
    editProtocol("idx-target", {
      description: "handles quantum flange calibration",
      triggers: ["calibrate flange"],
    });
    expect(loadCustomProtocols().length).toBe(countBefore);

    expect(await searchFor("flange")).toContain("idx-target");
    expect(await searchFor("widget")).not.toContain("idx-target");
  });

  it("surfaces a protocol edited through the pin path too", async () => {
    // Any write goes through the same choke point; pinning proves the
    // invalidation isn't wired to one caller.
    createProtocol(mkProtocol("pin-target", { description: "zzqx frobnicator", triggers: ["frobnicate"] }));
    expect(await searchFor("frobnicator")).toContain("pin-target");
    editProtocol("pin-target", { description: "wibble sprocket tuner", triggers: ["tune sprocket"] });
    expect(await searchFor("sprocket")).toContain("pin-target");
  });
});

describe("search relevance gate (F18)", () => {
  // The defect this fixes was observed in the real usage log, twice:
  //   searched "purchase order" → hit:true → instagram_post
  // against a catalog with no purchasing protocol at all. The filter was
  // `score > 0`, so one shared token — "order", from a step instruction — made
  // a hit. A confident wrong answer is worse than a miss: the miss is what tells
  // the agent to write the protocol.
  function usageRows(): Array<Record<string, unknown>> {
    const p = join(TEMP, "protocols", "usage.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("does not answer 'purchase order' with an unrelated protocol", async () => {
    const out = await searchFor("purchase order");
    expect(out).not.toContain("instagram_post");
    expect(out).toContain("No protocol in the catalog is about");
  });

  it("does not answer bare 'order' either — the one-word retry is not a bypass", async () => {
    // The first version of this gate required 2 matched terms, and the tool text
    // told the model to "retry with the single most distinctive word" on a miss.
    // On a one-term query that requirement collapsed to 1, i.e. back to the
    // pre-fix `score > 0`, and `order` returned instagram_post with hit:true —
    // regenerating the exact usage.jsonl row this was opened on, in one hop the
    // tool itself prescribed.
    const out = await searchFor("order");
    expect(out).not.toContain("instagram_post");
    const row = usageRows().find((r) => r.action === "searched" && r.query === "order");
    expect(row!.hit).toBe(false);
  });

  it("a more descriptive query never removes the answer a shorter one found", async () => {
    // Measured inversion in the first version of this gate: requiring N matched
    // terms makes every added word a new obligation, so `research` found
    // web_research and `company research` found NOTHING. Making a request more
    // specific must not make it less answerable — that is backwards, and it is
    // the same shape as the density inversion this subsystem has been bitten by
    // twice. Each pair below is (short query, the same query plus a word the
    // catalog doesn't know).
    const PAIRS: Array<[string, string, string]> = [
      ["research", "company research", "web_research"],
      ["slack", "slack webhook", "send_slack"],
      ["deploy", "roll back a deploy", "deploy"],
      ["git", "git commit please", "git_workflow"],
    ];
    for (const [short, longer, expected] of PAIRS) {
      expect(await searchFor(short)).toContain(expected);
      expect(await searchFor(longer)).toContain(expected);
    }
  });

  it("a generic verb is not evidence, even when the protocol really uses it", async () => {
    // `create purchase order` is the natural phrasing of the request that opened
    // this finding. It used to return instagram_post (two body words), and after
    // the identity rule it still returned git_workflow — "create a branch" is one
    // of that protocol's own triggers, so "create" was a genuine identity match.
    // It just isn't evidence about the SUBJECT. The generic-term set is shared
    // with learned-suggestion.ts so there is one answer to "is this word topical".
    const out = await searchFor("create purchase order");
    expect(out).not.toContain("git_workflow");
    expect(out).not.toContain("instagram_post");
    expect(out).toContain("No protocol in the catalog is about");
    const row = usageRows().find((r) => r.action === "searched" && r.query === "create purchase order");
    expect(row!.hit).toBe(false);

    // Same defect, different verb and different victim: "make an instagram post"
    // is one of instagram_post's triggers, so `make` matched its identity too.
    const other = await searchFor("make a new purchase order");
    expect(other).not.toContain("instagram_post");
    // NOT asserted: that this query misses entirely. It still matches app-build
    // on "new", and "new" cannot join the generic set — it moves a pinned aside
    // in learned-suggestion's labelled corpus over MIN_COVERAGE (2/6 → 2/5),
    // because dropping a term there shrinks the coverage DENOMINATOR and loosens
    // admission. The residual class is documented in generic-terms.ts rather
    // than closed by breaking the other consumer.
  });

  it("still finds the protocol when the same verb comes with a subject", async () => {
    // The filter must remove "create" as EVIDENCE without making requests that
    // contain it unanswerable — the subject word carries the match.
    createProtocol(mkProtocol("branch_flow", {
      description: "Create a git branch and push it",
      triggers: ["create a branch"],
    }));
    expect(await searchFor("create a branch")).toContain("branch_flow");
  });

  it("admits a match that is only in the description, not just the name", async () => {
    // `duplicate systems` matches brownfield on a description word alone. An
    // earlier candidate rule that trusted only name/triggers/tags dropped it.
    expect(await searchFor("duplicate systems")).toContain("brownfield");
  });

  it("records the miss as hit:false so the catalog gap is visible in telemetry", async () => {
    await searchFor("purchase order");
    const row = usageRows().find((r) => r.action === "searched" && r.query === "purchase order");
    expect(row).toBeDefined();
    expect(row!.hit).toBe(false);
    expect(row!.name).toBe("");
  });

  it("still hits when the protocol really does cover the query", async () => {
    createProtocol(mkProtocol("po_intake", {
      description: "Create a purchase order from a supplier invoice",
      triggers: ["purchase order intake"],
    }));
    const out = await searchFor("purchase order");
    expect(out).toContain("po_intake");
    expect(out).not.toContain("instagram_post");

    const row = usageRows().find((r) => r.action === "searched" && r.query === "purchase order");
    expect(row!.hit).toBe(true);
    expect(row!.name).toBe("po_intake");
  });

  it("keeps single-word search working — one term is all the evidence there is", async () => {
    createProtocol(mkProtocol("sprocket_flow", { description: "zzqx sprocket handling", triggers: ["sprocket"] }));
    expect(await searchFor("sprocket")).toContain("sprocket_flow");
  });

  it("does not become less useful as the catalog fills up with one topic", async () => {
    // The inversion that has bitten this campaign twice: an admission rule built
    // on corpus statistics gets STRICTER as more protocols share a topic, so the
    // more the agent writes about the user's actual work, the less any of it can
    // be retrieved. This gate reads only the query and the document, so density
    // cannot move it. Sweep 1 → 5 → 20 neighbours.
    for (const n of ["po_intake", "po_receiving", "po_reconcile", "po_close", "po_audit"]) {
      createProtocol(mkProtocol(n, {
        description: `${n}: a step in the purchase order lifecycle`,
        triggers: ["purchase order"],
      }));
    }
    expect(await searchFor("purchase order")).toContain("po_");

    for (let i = 0; i < 15; i += 1) {
      createProtocol(mkProtocol(`po_extra_${i}`, {
        description: `another purchase order variant ${i}`,
        triggers: ["purchase order"],
      }));
    }
    const out = await searchFor("purchase order");
    expect(out).not.toContain("No protocols matched");
    expect(out).toContain("po_");
  });

  it("drops the tail whose only overlap is a word buried in its body", async () => {
    // instagram_post matches on name, description AND body. git_workflow and
    // send_email match this query only on "new", and only inside their step
    // text — nothing in what either one says it is. They used to be listed as
    // matches alongside the right answer.
    const out = await searchFor("post the new product photos to instagram with a caption");
    expect(out).toContain("instagram_post");
    expect(out).not.toContain("git_workflow");
    expect(out).not.toContain("send_email");
  });
});

describe("authorProtocol provenance + body (F3/D9)", () => {
  it("stamps authoredBy/authoredAt/authoredFromSession onto the persisted record", async () => {
    const before = Date.now();
    const res = await authorProtocol({
      name: "agent-authored-one",
      description: "zzqx frobnicate the wibble pipeline",
      triggers: ["frobnicate zzqx pipeline"],
      body: "# Steps\n\n1. Do the thing.\n",
      authoredBy: "agent",
      authoredFromSession: "sess-fork-1",
    });

    expect(res.ok).toBe(true);
    const onDisk = (JSON.parse(readFileSync(join(TEMP, "protocols", "custom.json"), "utf-8")) as Protocol[])
      .find((p) => p.name === "agent-authored-one");
    expect(onDisk).toBeDefined();
    expect(onDisk!.source?.type).toBe("custom");
    expect(onDisk!.source?.authoredBy).toBe("agent");
    expect(onDisk!.source?.authoredFromSession).toBe("sess-fork-1");
    expect(onDisk!.source?.authoredAt).toBeGreaterThanOrEqual(before);
    // The markdown body is the other half of D9 — dedup AND a body, not a choice.
    expect(onDisk!.body).toBe("# Steps\n\n1. Do the thing.\n");
  });

  it("leaves authorship absent when the caller supplies none — never 'user'", async () => {
    const res = await authorProtocol({
      name: "unknown-author-one",
      description: "zzqx sprocket wibble alignment",
      triggers: ["align zzqx sprocket"],
    });
    expect(res.ok).toBe(true);
    const stored = loadCustomProtocols().find((p) => p.name === "unknown-author-one");
    expect(stored!.source?.authoredBy).toBeUndefined();
    expect(stored!.source?.authoredBy).not.toBe("user");
  });

  it("honours an explicit authoredAt instead of stamping now", async () => {
    await authorProtocol({
      name: "backdated-one",
      description: "zzqx flange wibble backfill",
      triggers: ["backfill zzqx flange"],
      authoredBy: "agent",
      authoredAt: 1_700_000_000_123,
    });
    expect(loadCustomProtocols().find((p) => p.name === "backdated-one")!.source?.authoredAt)
      .toBe(1_700_000_000_123);
  });
});

describe("dedup gate is shared by both create paths (F3)", () => {
  const EXISTING = {
    name: "download-chatgpt-image",
    description: "Download an image from a ChatGPT conversation",
    triggers: ["download chatgpt image"],
  };

  it("refuses a near-duplicate through authorProtocol()", async () => {
    createProtocol(mkProtocol(EXISTING.name, {
      description: EXISTING.description,
      triggers: EXISTING.triggers,
    }));

    const res = await authorProtocol({
      name: "download-chatgpt-image-again",
      description: EXISTING.description,
      triggers: EXISTING.triggers,
      body: "# would have been written blind",
    });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.duplicate.name).toBe(EXISTING.name);
    expect(res.duplicate.similarity).toBeGreaterThanOrEqual(0.85);
    // Refusal means refusal — nothing was persisted.
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("download-chatgpt-image-again");
  });

  it("still refuses through the protocol_create tool", async () => {
    createProtocol(mkProtocol(EXISTING.name, {
      description: EXISTING.description,
      triggers: EXISTING.triggers,
    }));
    const tool = createBuilderTools().find((t) => t.name === "protocol_create")!;
    const out = await tool.execute({
      name: "download-chatgpt-image-again",
      description: EXISTING.description,
      triggers: EXISTING.triggers,
      steps: [],
    });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("too similar");
  });

  it("lets a genuinely different protocol through, body and all", async () => {
    createProtocol(mkProtocol(EXISTING.name, {
      description: EXISTING.description,
      triggers: EXISTING.triggers,
    }));
    const res = await authorProtocol({
      name: "reconcile-vendor-invoices",
      description: "Reconcile vendor invoices against purchase orders",
      triggers: ["reconcile invoices"],
      body: "# Reconcile\n",
    });
    expect(res.ok).toBe(true);
    expect(loadCustomProtocols().find((p) => p.name === "reconcile-vendor-invoices")?.body).toBe("# Reconcile\n");
  });

  it("bypasses dedup when the caller names what it supersedes", async () => {
    createProtocol(mkProtocol(EXISTING.name, {
      description: EXISTING.description,
      triggers: EXISTING.triggers,
    }));
    const res = await authorProtocol({
      name: "download-chatgpt-image-v2",
      description: EXISTING.description,
      triggers: EXISTING.triggers,
      supersedes: EXISTING.name,
    });
    expect(res.ok).toBe(true);
    const names = loadCustomProtocols().map((p) => p.name);
    expect(names).toContain("download-chatgpt-image-v2");
    expect(names).not.toContain(EXISTING.name);
  });
});

describe("supersedes archives the target, never hard-deletes it (F27/F37)", () => {
  // `supersedes` is reachable from protocol(action:"create"), which is not in
  // DESTRUCTIVE_TOOL_ACTIONS and is blanket-allowed by the orchestration policy.
  // While it hard-deleted, the ordinary agent could erase a user-authored
  // protocol with no approval prompt and no undo — the one thing the recoverable
  // archive is supposed to guarantee.
  it("moves the superseded protocol into the archive, content intact", async () => {
    createProtocol(mkProtocol("po-intake", {
      description: "the user's own hand-written flow",
      steps: [{ id: "s1", instruction: "IRREPLACEABLE USER CONTENT" }],
      source: { type: "custom", authoredBy: "user", authoredAt: 111 },
    }));

    const res = await authorProtocol({
      name: "po-intake-v2",
      description: "the agent's rewrite",
      triggers: ["po intake"],
      supersedes: "po-intake",
    });

    expect(res.ok).toBe(true);
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("po-intake");

    const record = loadArchived().find((r) => r.protocol.name === "po-intake");
    expect(record).toBeDefined();
    expect(record!.protocol.steps[0].instruction).toBe("IRREPLACEABLE USER CONTENT");
    expect(record!.protocol.source?.authoredBy).toBe("user");
    expect(record!.reason).toContain("po-intake-v2");
  });

  it("is undoable — the superseded protocol restores with its content", async () => {
    createProtocol(mkProtocol("old-flow", { description: "ORIGINAL" }));
    await authorProtocol({
      name: "new-flow", description: "replacement", triggers: ["new flow"], supersedes: "old-flow",
    });

    const restored = unarchiveProtocol("old-flow");
    expect(restored.error).toBeUndefined();
    expect(restored.restored?.description).toBe("ORIGINAL");
    expect(loadCustomProtocols().map((p) => p.name)).toEqual(
      expect.arrayContaining(["old-flow", "new-flow"]),
    );
  });

  it("tells the caller the old one is recoverable instead of implying it's gone", async () => {
    createProtocol(mkProtocol("superseded-note"));
    const res = await authorProtocol({
      name: "superseded-note-v2", description: "x", triggers: ["y"], supersedes: "superseded-note",
    });
    if (!res.ok) throw new Error("unreachable");
    expect(res.supersededNote).toMatch(/archived/i);
    expect(res.supersededNote).toMatch(/unarchive/);
  });

  it("reports honestly when the superseded name isn't in the editable catalog", async () => {
    const res = await authorProtocol({
      name: "supersedes-nothing", description: "x", triggers: ["y"], supersedes: "instagram_post",
    });
    if (!res.ok) throw new Error("unreachable");
    expect(res.supersededNote).toMatch(/nothing was replaced/);
    // A built-in isn't in custom.json, so there was nothing to archive — and
    // nothing may be silently removed from anywhere else either.
    expect(loadArchived()).toHaveLength(0);
  });
});

describe("the agent's own archive action never destroys the live copy (F24)", () => {
  // Chunk G guarded the HTTP route. This is the OTHER path: the model calling
  // protocol(action:'delete'), which reaches the raw primitive. It only ever
  // inspected the null return, so it reported "not found in active catalog"
  // for a record that its own call had just deleted.
  const del = createBuilderTools().find((t) => t.name === "protocol_delete")!;

  it("archives a re-created name alongside the older archived version", async () => {
    createProtocol(mkProtocol("agentpath", { description: "VERSION ONE" }));
    expect((await del.execute({ name: "agentpath" })).isError).toBeFalsy();

    // Re-creatable because createProtocol only checks the LIVE catalog — the
    // normal state of affairs for an agent that re-authors protocols.
    createProtocol(mkProtocol("agentpath", { description: "VERSION TWO" }));
    const out = await del.execute({ name: "agentpath" });

    expect(out.isError).toBeFalsy();
    expect(String(out.content)).toContain("Archived");
    const archived = loadArchived()
      .filter((r) => r.protocol.name === "agentpath")
      .map((r) => r.protocol.description)
      .sort();
    expect(archived).toEqual(["VERSION ONE", "VERSION TWO"]);
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("agentpath");
  });

  it("still refuses names that aren't in the editable catalog, without touching anything", async () => {
    const out = await del.execute({ name: "instagram_post" });
    expect(out.isError).toBe(true);
    expect(String(out.content)).toContain("nothing to archive");
    expect(loadArchived()).toHaveLength(0);
  });

  it("restores the version the user last archived", async () => {
    createProtocol(mkProtocol("restore-newest", { description: "VERSION ONE" }));
    await del.execute({ name: "restore-newest" });
    createProtocol(mkProtocol("restore-newest", { description: "VERSION TWO" }));
    await del.execute({ name: "restore-newest" });

    const unarchive = createBuilderTools().find((t) => t.name === "protocol_unarchive")!;
    const out = await unarchive.execute({ name: "restore-newest" });
    expect(out.isError).toBeFalsy();
    expect(loadCustomProtocols().find((p) => p.name === "restore-newest")?.description)
      .toBe("VERSION TWO");
  });

  it("restores an older version when the agent passes its archivedTs", async () => {
    createProtocol(mkProtocol("restore-older", { description: "VERSION ONE" }));
    const first = archiveProtocol("restore-older")!;
    createProtocol(mkProtocol("restore-older", { description: "VERSION TWO" }));
    await del.execute({ name: "restore-older" });

    const unarchive = createBuilderTools().find((t) => t.name === "protocol_unarchive")!;
    const out = await unarchive.execute({ name: "restore-older", archivedTs: first.archivedTs });
    expect(out.isError).toBeFalsy();
    expect(loadCustomProtocols().find((p) => p.name === "restore-older")?.description)
      .toBe("VERSION ONE");
  });

  it("lists every archived version with the stamp needed to restore it", async () => {
    createProtocol(mkProtocol("listed", { description: "VERSION ONE" }));
    await del.execute({ name: "listed" });
    createProtocol(mkProtocol("listed", { description: "VERSION TWO" }));
    await del.execute({ name: "listed" });

    const list = createBuilderTools().find((t) => t.name === "protocol_list_archived")!;
    const content = String((await list.execute({})).content);
    expect(content.match(/- listed \(/g) ?? []).toHaveLength(2);
    for (const r of loadArchived()) expect(content).toContain(String(r.archivedTs));
  });
});

describe("edit invalidates the cached dedup embedding (F4)", () => {
  it("drops the entry when the embedded text changes", async () => {
    createProtocol(mkProtocol("embed-target", { description: "original", triggers: ["orig"] }));
    writeEmbeddingCache({ "embed-target": "stale-hash" });

    editProtocol("embed-target", { description: "rewritten entirely", triggers: ["new trigger"] });
    await flushMicrotasks();

    expect(readEmbeddingCache()).not.toHaveProperty("embed-target");
  });

  it("drops the OLD key on a rename so nothing is orphaned", async () => {
    createProtocol(mkProtocol("rename-from", { description: "same text", triggers: ["same"] }));
    writeEmbeddingCache({ "rename-from": "stale-hash" });

    editProtocol("rename-from", { name: "rename-to" });
    await flushMicrotasks();

    const cache = readEmbeddingCache();
    expect(cache).not.toHaveProperty("rename-from");
    expect(cache).not.toHaveProperty("rename-to");
  });

  it("keeps the entry when the edit can't affect the embedding", async () => {
    // pinned/steps/rules are not part of the embedded text; re-embedding on
    // every pin would be pure waste.
    createProtocol(mkProtocol("keep-embed", { description: "unchanged", triggers: ["unchanged"] }));
    writeEmbeddingCache({ "keep-embed": "stale-hash" });

    editProtocol("keep-embed", { pinned: true });
    await flushMicrotasks();

    expect(readEmbeddingCache()).toHaveProperty("keep-embed");
  });
});

describe("the embedding cache survives a concurrent refresh (F4 race)", () => {
  it("does not resurrect an orphan dropped while a dedup pass is mid-embed", async () => {
    // The repro that refuted the first version of this fix. A dedup pass loads
    // the whole cache, awaits provider.embed(), then writes its snapshot back.
    // A rename landing inside that window drops the old key — and the snapshot
    // write puts it straight back. Nothing is named "alpha" any more, so no
    // later refresh ever revisits it: the orphan is permanent, in a file that
    // syncs to every machine.
    createProtocol(mkProtocol("alpha", { description: "alpha does the alpha thing", triggers: ["alpha"] }));
    createProtocol(mkProtocol("beta", { description: "beta does the beta thing", triggers: ["beta"] }));

    // Prime the cache so "alpha" is present and fresh.
    await findCatalogDuplicate({ name: "primer", description: "zzqx primer wibble", triggers: ["primer"] });
    expect(readEmbeddingCache()).toHaveProperty("alpha");

    // Make one protocol stale so the next pass must actually await an embed.
    editProtocol("beta", { description: "beta rewritten so its hash changes", triggers: ["beta v2"] });
    await flushMicrotasks();

    // Park a dedup pass inside that await.
    openEmbedGate();
    const forkPass = findCatalogDuplicate({ name: "fork-candidate", description: "zzqx fork wibble", triggers: ["fork"] });
    await waitForEmbeds(1);

    // Foreground renames alpha → gamma while the pass is parked.
    editProtocol("alpha", { name: "gamma" });
    await flushMicrotasks();
    expect(readEmbeddingCache()).not.toHaveProperty("alpha");

    // Let the parked pass finish and write.
    releaseEmbedGate();
    await forkPass;

    expect(readEmbeddingCache()).not.toHaveProperty("alpha");
    expect(loadCustomProtocols().map((p) => p.name)).toContain("gamma");
  });

  it("does not revert a concurrent update to a protocol that is still live", async () => {
    // Isolates the RE-READ half. The rename test above passes even with a
    // stale-snapshot write, because the prune deletes the resurrected key
    // anyway — nothing is named "alpha" any more. Here "alpha" keeps its name,
    // so it stays in the live catalog and the prune cannot mask anything: the
    // only thing that can keep the concurrent drop is re-reading the cache
    // after the awaits instead of writing back the pre-await snapshot.
    createProtocol(mkProtocol("alpha", { description: "alpha does the alpha thing", triggers: ["alpha"] }));
    createProtocol(mkProtocol("beta", { description: "beta does the beta thing", triggers: ["beta"] }));

    await findCatalogDuplicate({ name: "primer", description: "zzqx primer wibble", triggers: ["primer"] });
    expect(readEmbeddingCache()).toHaveProperty("alpha");

    // Make "beta" stale so the next pass must await an embed.
    editProtocol("beta", { description: "beta rewritten so its hash changes", triggers: ["beta v2"] });
    await flushMicrotasks();

    embedLog.length = 0;
    openEmbedGate();
    const forkPass = findCatalogDuplicate({ name: "fork-candidate", description: "zzqx fork wibble", triggers: ["fork"] });
    await waitForEmbeds(1);

    // Foreground rewords "alpha" — same name, so it stays live; its stale
    // vector is dropped so the next pass re-embeds the new wording.
    editProtocol("alpha", { description: "alpha rewritten entirely", triggers: ["alpha v2"] });
    await flushMicrotasks();
    expect(readEmbeddingCache()).not.toHaveProperty("alpha");

    releaseEmbedGate();
    await forkPass;

    // A snapshot write puts alpha's PRE-EDIT vector back, and the prune keeps
    // it because alpha is live — leaving dedup comparing against wording the
    // protocol no longer has.
    expect(readEmbeddingCache()).not.toHaveProperty("alpha");
  });

  it("prunes an orphan even when no drop ever ran", async () => {
    // The self-correcting half: a drop that was lost, never fired, or raced
    // must not be the only defence. Any key the live catalog doesn't claim is
    // reconciled away by the next pass.
    createProtocol(mkProtocol("live-one", { description: "zzqx live wibble", triggers: ["live"] }));
    writeEmbeddingCache({ "ghost-protocol": "orphan-hash", "live-one": "stale-hash" });

    await findCatalogDuplicate({ name: "reconcile-probe", description: "zzqx probe wibble", triggers: ["probe"] });

    const cache = readEmbeddingCache();
    expect(cache).not.toHaveProperty("ghost-protocol");
    expect(cache).toHaveProperty("live-one");
  });

  it("prunes the embedding of an archived protocol", async () => {
    createProtocol(mkProtocol("to-archive", { description: "zzqx archive wibble", triggers: ["archive me"] }));
    await findCatalogDuplicate({ name: "probe-a", description: "zzqx probe alpha", triggers: ["probe a"] });
    expect(readEmbeddingCache()).toHaveProperty("to-archive");

    archiveProtocol("to-archive");
    await findCatalogDuplicate({ name: "probe-b", description: "zzqx probe bravo", triggers: ["probe b"] });

    expect(readEmbeddingCache()).not.toHaveProperty("to-archive");
  });
});

describe("a degraded catalog read prunes nothing (R3)", () => {
  // The prune deletes everything the catalog doesn't claim, but every tier
  // read degrades an I/O failure to "empty". Deleting on a partial read costs
  // a full re-embed of the catalog, atomically written into a git-synced file
  // and propagated to every machine. Skipping costs one pass of orphan
  // retention. These pin that the trade is made the safe way.

  it("keeps custom-tier vectors when custom.json is unparseable", async () => {
    createProtocol(mkProtocol("alpha", { description: "zzqx alpha wibble", triggers: ["alpha"] }));
    createProtocol(mkProtocol("beta", { description: "zzqx beta wibble", triggers: ["beta"] }));
    createProtocol(mkProtocol("gamma", { description: "zzqx gamma wibble", triggers: ["gamma"] }));

    await findCatalogDuplicate({ name: "primer", description: "zzqx primer sprocket", triggers: ["primer"] });
    for (const n of ["alpha", "beta", "gamma"]) expect(readEmbeddingCache()).toHaveProperty(n);

    // Exactly what a `git pull` conflict leaves behind in a workspace-synced
    // file. loadCustomProtocols() catches the parse error and returns [].
    writeFileSync(
      join(TEMP, "protocols", "custom.json"),
      '<<<<<<< HEAD\n[{"name":"alpha"}]\n=======\n[{"name":"beta"}]\n>>>>>>> origin/main\n',
      "utf-8",
    );
    expect(loadCustomProtocols()).toEqual([]);

    await findCatalogDuplicate({ name: "after-corrupt", description: "zzqx corrupt sprocket", triggers: ["after"] });

    const cache = readEmbeddingCache();
    for (const n of ["alpha", "beta", "gamma"]) expect(cache).toHaveProperty(n);
  });

  it("keeps SKILL.md-tier vectors when the directory read throws EBUSY", async () => {
    createProtocol(mkProtocol("delta", { description: "zzqx delta wibble", triggers: ["delta"] }));
    await findCatalogDuplicate({ name: "primer", description: "zzqx primer flange", triggers: ["primer"] });

    // Assert on the tier that actually fails, not a bystander: these are the
    // vectors a trusting prune would delete.
    const bundledNames = loadBundledProtocols().map((p) => p.name);
    expect(bundledNames.length).toBeGreaterThan(0);
    expect(Object.keys(readEmbeddingCache())).toEqual(expect.arrayContaining(bundledNames));

    invalidateBundledCache();
    fsSpy.failReaddir.add(bundledProtocolsDir());
    await findCatalogDuplicate({ name: "during-ebusy", description: "zzqx ebusy flange", triggers: ["ebusy"] });

    const keys = Object.keys(readEmbeddingCache());
    expect(keys).toEqual(expect.arrayContaining(bundledNames));
    expect(keys).toContain("delta");
  });

  /** Write a SKILL.md pack into the workspace imported tier. */
  function mkImported(name: string, contents: string): string {
    const dir = join(importedProtocolsDir(), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), contents, "utf-8");
    return dir;
  }

  it("counts a SKILL.md that exists but parses to nothing", () => {
    // readFileSync SUCCEEDS on a zero-byte file, so nothing upstream notices;
    // parseSkillMd returns null, the protocol drops out of the catalog, and a
    // trusting prune deletes its vector. The file is right there on disk — this
    // is a partial read, not a deletion.
    mkImported("real-one", "---\nname: real-one\ndescription: a real one\n---\n\nDo it.\n");
    mkImported("empty-one", "");

    const before = catalogReadFailureCount();
    const names = loadImportedProtocols().map((p) => p.name);
    const after = catalogReadFailureCount();

    expect(names).toContain("real-one");
    expect(names).not.toContain("empty-one");
    expect(after).toBe(before + 1);
  });

  it("counts a SKILL.md that can't be read at all", () => {
    // A directory where the file should be: existsSync says yes, readFileSync
    // throws EISDIR. Same shape as an EPERM or a mid-sync lock.
    mkdirSync(join(importedProtocolsDir(), "unreadable-one", "SKILL.md"), { recursive: true });

    const before = catalogReadFailureCount();
    loadImportedProtocols();
    expect(catalogReadFailureCount()).toBe(before + 1);
  });

  it("counts an entry that can't be stat'd", () => {
    const dir = mkImported("unstattable-one", "---\nname: unstattable-one\ndescription: x\n---\n\nBody.\n");
    fsSpy.failStat.add(dir);

    const before = catalogReadFailureCount();
    const names = loadImportedProtocols().map((p) => p.name);
    expect(names).not.toContain("unstattable-one");
    expect(catalogReadFailureCount()).toBe(before + 1);
  });

  it("survives a custom.json that parses but isn't an array", () => {
    // `{"name":"oops"}` parses fine, so the parse-error branch never fires;
    // stampCustomSource() then does records.map(...) and throws
    // "records.map is not a function", taking down getAllProtocols() and with it
    // the whole authoring path.
    writeFileSync(join(TEMP, "protocols", "custom.json"), '{"name":"oops"}', "utf-8");

    const before = catalogReadFailureCount();
    expect(loadCustomProtocols()).toEqual([]);
    expect(catalogReadFailureCount()).toBe(before + 1);
    // The real read path must not throw either — that is where the crash landed.
    expect(() => getAllProtocols()).not.toThrow();
    expect(getAllProtocols().length).toBeGreaterThan(0);
  });

  it("keeps custom-tier vectors when custom.json isn't an array", async () => {
    createProtocol(mkProtocol("kappa", { description: "zzqx kappa wibble", triggers: ["kappa"] }));
    await findCatalogDuplicate({ name: "primer", description: "zzqx primer kappa", triggers: ["primer"] });
    expect(readEmbeddingCache()).toHaveProperty("kappa");

    writeFileSync(join(TEMP, "protocols", "custom.json"), '{"name":"oops"}', "utf-8");
    await findCatalogDuplicate({ name: "after-shape", description: "zzqx shape sprocket", triggers: ["after"] });

    expect(readEmbeddingCache()).toHaveProperty("kappa");
  });

  it("still memoizes the bundled tier when one pack is unparseable", () => {
    // The memo must distrust a TRANSIENT failure (EBUSY may succeed next call)
    // but not a STABLE gap. A zero-byte SKILL.md fails identically forever, so
    // treating it as a failed read means never memoizing again — and because
    // every call then re-scans and re-reports failure, the embedding prune is
    // silently disabled for the whole process.
    const probe = join(bundledProtocolsDir(), "__memo_probe__");
    try {
      mkdirSync(probe, { recursive: true });
      writeFileSync(join(probe, "SKILL.md"), "", "utf-8");
      invalidateBundledCache();

      const before = catalogReadFailureCount();
      const first = loadBundledProtocols();
      const afterFirst = catalogReadFailureCount();
      expect(afterFirst).toBeGreaterThan(before); // the gap IS reported, once
      expect(first.map((p) => p.name)).not.toContain("__memo_probe__");

      // Second call must come from the memo: no re-scan, no further report.
      loadBundledProtocols();
      expect(catalogReadFailureCount()).toBe(afterFirst);
    } finally {
      rmSync(probe, { recursive: true, force: true });
      invalidateBundledCache();
    }
    expect(existsSync(probe)).toBe(false);
  });

  it("does not memoize a failed bundled read", () => {
    // invalidateBundledCache() has zero production callers, so a poisoned memo
    // is permanent for the process: one transient EBUSY at boot would make the
    // bundled tier read empty on every later call, and the prune would then
    // delete every bundled vector on every pass.
    invalidateBundledCache();
    fsSpy.failReaddir.add(bundledProtocolsDir());
    expect(loadBundledProtocols()).toEqual([]);

    fsSpy.failReaddir.clear();
    expect(loadBundledProtocols().length).toBeGreaterThan(0);
  });
});

describe("catalog files are replaced atomically, never written in place (F2)", () => {
  // These pin the atomicity CONTRACT by observing the real fs calls: the
  // payload goes to a temp path and is renamed onto the destination, so no
  // reader can ever observe the destination partially written. They do NOT
  // simulate a crash — a crash-mid-write harness isn't practical here, and
  // atomicWriteFileSync's own failure/contention behaviour is covered in
  // src/util/json-store.test.ts. What would regress without these is the
  // routing: a call reverted to writeFileSync writes the payload straight at
  // the destination, and every other assertion in this suite still passes.
  function assertReplacedAtomically(target: string): void {
    const direct = fsSpy.writes.filter((w) => w === target);
    expect(direct).toEqual([]);
    const tmp = fsSpy.writes.filter((w) => w.startsWith(target + ".tmp."));
    expect(tmp.length).toBeGreaterThan(0);
    expect(fsSpy.renames.some((r) => r.from === tmp[tmp.length - 1] && r.to === target)).toBe(true);
  }

  it("custom.json", () => {
    fsSpy.writes.length = 0;
    fsSpy.renames.length = 0;
    createProtocol(mkProtocol("atomic-custom"));
    assertReplacedAtomically(join(TEMP, "protocols", "custom.json"));
    expect(loadCustomProtocols().map((p) => p.name)).toContain("atomic-custom");
  });

  it("archived.json", () => {
    createProtocol(mkProtocol("atomic-archived"));
    fsSpy.writes.length = 0;
    fsSpy.renames.length = 0;
    archiveProtocol("atomic-archived", "test");
    assertReplacedAtomically(join(TEMP, "protocols", "archived.json"));
  });

  it("embeddings.json", () => {
    writeEmbeddingCache({ "atomic-embed": "hash" });
    fsSpy.writes.length = 0;
    fsSpy.renames.length = 0;
    dropEmbedding("atomic-embed");
    assertReplacedAtomically(join(TEMP, "protocols", "embeddings.json"));
    expect(readEmbeddingCache()).not.toHaveProperty("atomic-embed");
  });
});

