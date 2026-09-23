/**
 * CLASS INVARIANT: a fact's rendered date is when the thing HAPPENED, or the
 * page says it does not know. It is never silently the time memory wrote it
 * down.
 *
 * The two clocks diverge by however long consolidation takes to run, which is
 * routinely a day or more. Live case 2026-09-22: the user discussed nerve
 * peptides on the 22nd; the consolidation pass ran 11:43 on the 23rd; every
 * date on the resulting entity page — the page header AND the fact's own
 * stamp — said 2026-09-23, because both were `Date.now()` at write time. Asked
 * "have I ever asked about this", the agent answered "Yeah — today,
 * 2026-09-23" and was believed. It had no way to know better: the page was the
 * only thing it read, and the page was wrong.
 *
 * That is a silent seam — nothing errors, the answer is simply false — so it
 * gets a contract rather than a unit test, and the assertions are written
 * against the RENDERED page, which is the artifact the model actually reads.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prevLaxDir = process.env.LAX_DATA_DIR;
const tmp = mkdtempSync(join(tmpdir(), "lax-fact-date-"));
process.env.LAX_DATA_DIR = tmp;

const { MemoryIndex } = await import("./index-core.js");
const { createInternalMemoryContext } = await import("./promotion-gate.js");

type Index = InstanceType<typeof MemoryIndex>;
type Fact = import("./types.js").RetainedFact;

const DAY = 86_400_000;
const CONVERSATION = Date.parse("2026-09-22T22:09:00Z"); // when it happened
const CONSOLIDATION = Date.parse("2026-09-23T11:43:00Z"); // when memory noticed

let index: Index;
let dir: string;
let entitiesDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmp, "idx-"));
  // MemoryIndex roots its bank under <dataDir>/memory (index-core.ts:61).
  entitiesDir = join(dir, "memory", "bank", "entities");
  mkdirSync(entitiesDir, { recursive: true });
  index = new MemoryIndex(dir);
});

/** Retain through the real gate, carrying an explicit event time. */
function retain(text: string, sourceFile: string, occurredAt?: number): Fact[] {
  return index.retain(
    text,
    sourceFile,
    0,
    createInternalMemoryContext(text, "memory:retain", "test-fact"),
    occurredAt,
  );
}

/** The page the model reads, as text. Goes through the real reflect pass —
 *  the same path that produced the page in the incident — rather than poking
 *  the renderer directly, so the test breaks if either end of the seam moves. */
async function renderPage(slug: string): Promise<string> {
  await index.reflect(365);
  const path = join(entitiesDir, `${slug}.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("a fact's date is the event, not the write", () => {
  it("renders the date the thing happened, not the date memory recorded it", async () => {
    retain(
      "- W @ara-290: ARA-290 is a peptide with human trial data on nerve density.",
      "consolidation:sessions/chat-mud86mrr.jsonl",
      CONVERSATION,
    );

    const page = await renderPage("ara-290");
    expect(page).toContain("2026-09-22");
    // The exact failure: the write date asserted as the event date.
    expect(page).not.toContain("— *2026-09-23*");
  });

  it("says it does not know rather than falling back to the write time", async () => {
    // Every fact retained before this column existed is in this state, and so
    // is anything from a source that carries no date. Substituting the write
    // time here is exactly the bug, just with a fresher-looking number.
    retain("- W @dihexa: Dihexa is an angiotensin-derived peptide.", "agent-tool");

    const page = await renderPage("dihexa");
    expect(page).toContain("date unknown");
    expect(page).toContain("recorded");
  });

  it("labels the page's own rebuild stamp as maintenance, not as an event date", async () => {
    // It used to read "*Last reflected: <today>*" as the only date on the page.
    // One date on a page is taken to be the date of the thing described.
    retain("- W @semax: Semax is a nootropic peptide.", "agent-tool", CONVERSATION);

    const page = await renderPage("semax");
    expect(page).toContain("Page rebuilt:");
    expect(page).toMatch(/NOT when these things happened/i);
    expect(page).not.toContain("Last reflected");
  });

  it("keeps the write time available — consolidation timing still matters for debugging recall", async () => {
    retain("- W @bpc-157: BPC-157 is a pentadecapeptide.", "agent-tool");
    expect(await renderPage("bpc-157")).toMatch(/recorded \d{4}-\d{2}-\d{2}/);
  });

  it("round-trips occurredAt through the DB, so a reread is not the write time either", () => {
    const [fact] = retain(
      "- W @cibinetide: Cibinetide is ARA-290's generic name.",
      "consolidation:sessions/x.jsonl",
      CONVERSATION,
    );
    const reread = index.recallByEntity("cibinetide", 5)[0];
    expect(reread.occurredAt).toBe(CONVERSATION);
    expect(reread.timestamp).not.toBe(CONVERSATION);
    expect(fact.occurredAt).toBe(CONVERSATION);
  });

  it("a day-old conversation does not read as today", async () => {
    // The incident, reduced: two facts about the same entity, one from
    // yesterday's conversation and one from today's, both written by the same
    // consolidation pass. They must not render as the same day.
    retain("- W @peptide-a: Fact from the earlier conversation.", "consolidation:a", CONSOLIDATION - DAY);
    retain("- W @peptide-a: Fact from the later conversation.", "consolidation:b", CONSOLIDATION);

    const page = await renderPage("peptide-a");
    expect(page).toContain("2026-09-22");
    expect(page).toContain("2026-09-23");
  });
});

afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  // Best-effort: sqlite handles stay open for the process's lifetime, so a
  // forced unlink races them on Windows. Leaving a temp dir behind is cheaper
  // than a flaky teardown failing an otherwise-green contract.
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* handle still open */ }
});
