/**
 * HTTP-layer regression tests for the recoverable-delete story.
 *
 * Why these exist: agent-authored protocols are written with no confirmation
 * gate, so "the user can see it and undo it from the UI" IS the safety story.
 * That story is only true if (a) the default delete archives rather than
 * erases, (b) the archive is readable over HTTP, and (c) unarchive works over
 * HTTP. Each of those is asserted here against the real route handler and real
 * on-disk storage — no mocking of the protocol modules, so a regression in the
 * route wiring, the archive round-trip, or the response contract fails this.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntimeConfig, getRuntimeConfig } from "../src/config.js";
import type { LAXConfig } from "../src/types.js";
import type { ServerContext } from "../src/server-context.js";
import { handleProtocolRoutes } from "../src/routes/bridges/protocols.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";
import { loadArchived, archiveProtocol } from "../src/protocols/archive.js";
import { createProtocol, loadCustomProtocols, saveCustomProtocols } from "../src/protocols/builder.js";
import type { Protocol } from "../src/protocols/types.js";

let TEMP: string;
let TEMP_LAX: string;
let ORIGINAL_CFG: LAXConfig;
let ORIGINAL_LAX_DATA_DIR: string | undefined;

beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-proto-route-test-"));
  ORIGINAL_CFG = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP } as LAXConfig);
  // Pin LAX_DATA_DIR for the same reason protocols-archive.test.ts does: the
  // loader runs legacy migrations that renameSync real user dirs into the
  // workspace. Unpinned, this suite would eat the dev box's imported protocols.
  TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-proto-route-test-laxdir-"));
  ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = TEMP_LAX;
});

beforeEach(() => {
  saveCustomProtocols([]);
  const archived = join(TEMP, "protocols", "archived.json");
  if (existsSync(archived)) rmSync(archived);
  const imported = join(TEMP, "protocols", "imported");
  if (existsSync(imported)) rmSync(imported, { recursive: true, force: true });
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

/** An imported SKILL.md protocol: visible to getAllProtocols(), absent from
 *  custom.json — the tier where both delete paths silently no-op. */
function mkImported(name: string): void {
  const dir = join(TEMP, "protocols", "imported", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: an imported one\n---\n\nDo the thing.\n`, "utf-8");
}

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(`http://test${path}`);
  const req = mockJsonRequest(body ?? {});
  const captured = mockResponse();
  const handled = await handleProtocolRoutes(
    method, url, req, captured.res, {} as ServerContext, "operator",
  );
  return {
    handled,
    status: captured.status,
    json: <T = Record<string, unknown>>() => JSON.parse(captured.body) as T,
  };
}

describe("DELETE /api/protocols/:name — archive is the default, permanent is opt-in", () => {
  it("soft-archives by default: gone from live, recoverable from archived.json", async () => {
    createProtocol(mkProtocol("soft_target"));

    const res = await call("DELETE", "/api/protocols/soft_target");
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: "archived" });

    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("soft_target");
    expect(loadArchived().map((r) => r.protocol.name)).toContain("soft_target");
  });

  it("?permanent=true erases it — NOT recoverable from the archive", async () => {
    createProtocol(mkProtocol("hard_target"));

    const res = await call("DELETE", "/api/protocols/hard_target?permanent=true");
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: "permanent" });

    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("hard_target");
    expect(loadArchived().map((r) => r.protocol.name)).not.toContain("hard_target");
  });

  it("records the archive reason when one is supplied", async () => {
    createProtocol(mkProtocol("with_reason"));
    await call("DELETE", "/api/protocols/with_reason?reason=agent%20wrote%20junk");
    expect(loadArchived().find((r) => r.protocol.name === "with_reason")?.reason)
      .toBe("agent wrote junk");
  });

  it("still refuses built-ins", async () => {
    const res = await call("DELETE", "/api/protocols/instagram_post");
    expect(res.status).toBe(403);
  });

  it("archiving an already-archived name keeps BOTH versions", async () => {
    // This used to be a 409. The archive kept one record per name, and
    // archiveProtocol() resolved the clash by hard-deleting the live record
    // without archiving it, so the route refused before taking that side effect.
    // The archive is versioned now, so the refusal was over-strict and left the
    // user a dead end (archive → 409, unarchive → 409, permanent delete → gone)
    // on a state the agent hits routinely: createProtocol only rejects collisions
    // against the LIVE catalog, so an archived name is instantly re-creatable.
    // What must never regress is the data: no archive may lose a version.
    createProtocol(mkProtocol("notes", { description: "VERSION ONE" }));
    expect((await call("DELETE", "/api/protocols/notes")).status).toBe(200);
    expect((await call("POST", "/api/protocols", { name: "notes", description: "VERSION TWO" })).status).toBe(200);

    const res = await call("DELETE", "/api/protocols/notes");
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: "archived" });

    // Neither copy may be lost, and they must be distinguishable — archivedTs is
    // the discriminator every restore path keys on.
    expect(loadCustomProtocols().map((p) => p.name)).not.toContain("notes");
    const archived = loadArchived().filter((r) => r.protocol.name === "notes");
    expect(archived.map((r) => r.protocol.description).sort()).toEqual(["VERSION ONE", "VERSION TWO"]);
    expect(new Set(archived.map((r) => r.archivedTs)).size).toBe(2);
  });

  it("archives a third version too — the archive is not capped at two", async () => {
    createProtocol(mkProtocol("thrice", { description: "V1" }));
    await call("DELETE", "/api/protocols/thrice");
    await call("POST", "/api/protocols", { name: "thrice", description: "V2" });
    await call("DELETE", "/api/protocols/thrice");
    await call("POST", "/api/protocols", { name: "thrice", description: "V3" });
    expect((await call("DELETE", "/api/protocols/thrice")).status).toBe(200);

    expect(loadArchived().filter((r) => r.protocol.name === "thrice").map((r) => r.protocol.description).sort())
      .toEqual(["V1", "V2", "V3"]);
  });

  it("reports a no-op removal instead of claiming success (imported tier)", async () => {
    // Neither delete path can touch an imported SKILL.md that was never edited
    // into custom.json. Saying 200/ok for a removal that did nothing is the same
    // lie the "Delete"-that-archived button used to tell.
    mkImported("imported_only");
    const soft = await call("DELETE", "/api/protocols/imported_only");
    expect(soft.status).toBe(409);
    expect(soft.json<{ ok: boolean }>().ok).toBe(false);

    const hard = await call("DELETE", "/api/protocols/imported_only?permanent=true");
    expect(hard.status).toBe(409);
    expect(hard.json<{ ok: boolean }>().ok).toBe(false);

    // Still there — the route told the truth about not removing it.
    const { getAllProtocols } = await import("../src/protocols/index.js");
    expect(getAllProtocols().map((p) => p.name)).toContain("imported_only");
  });
});

describe("GET /api/protocols/archived", () => {
  it("lists archived records with their timestamp, reason and provenance", async () => {
    createProtocol(mkProtocol("agent_made", {
      source: { type: "custom", authoredBy: "agent", authoredAt: 1_700_000_000_000, authoredFromSession: "sess-1" },
    }));
    archiveProtocol("agent_made", "superseded");

    const res = await call("GET", "/api/protocols/archived");
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    const body = res.json<{ archived: Array<{ name: string; reason?: string; archivedTs: number; source: { authoredBy?: string } }> }>();
    expect(body.archived).toHaveLength(1);
    expect(body.archived[0].name).toBe("agent_made");
    expect(body.archived[0].reason).toBe("superseded");
    expect(body.archived[0].archivedTs).toBeGreaterThan(0);
    // Provenance must survive to the UI or the user can't tell whose work
    // they're being offered back.
    expect(body.archived[0].source.authoredBy).toBe("agent");
  });

  it("returns an empty list, not a 404, when nothing is archived", async () => {
    const res = await call("GET", "/api/protocols/archived");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ archived: [] });
  });

});

describe("POST /api/protocols/:name/unarchive", () => {
  it("restores an archived protocol to the live catalog", async () => {
    createProtocol(mkProtocol("restore_me"));
    await call("DELETE", "/api/protocols/restore_me");
    expect(loadCustomProtocols()).toHaveLength(0);

    const res = await call("POST", "/api/protocols/restore_me/unarchive");
    expect(res.handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.json<{ ok: boolean; protocol: Protocol }>().protocol.name).toBe("restore_me");

    expect(loadCustomProtocols().map((p) => p.name)).toContain("restore_me");
    expect(loadArchived()).toHaveLength(0);
  });

  it("round-trips agent provenance so restored work is still identifiable", async () => {
    const source = { type: "custom" as const, authoredBy: "agent" as const, authoredAt: 1_700_000_000_000, authoredFromSession: "sess-9" };
    createProtocol(mkProtocol("prov_route", { source: { ...source } }));
    await call("DELETE", "/api/protocols/prov_route");
    const res = await call("POST", "/api/protocols/prov_route/unarchive");
    expect(res.json<{ protocol: Protocol }>().protocol.source).toEqual(source);
  });

  it("404s for a name that isn't archived", async () => {
    const res = await call("POST", "/api/protocols/never_existed/unarchive");
    expect(res.status).toBe(404);
    expect(res.json<{ ok: boolean }>().ok).toBe(false);
  });

  /** Archive `name` twice with different bodies. Returns the two stamps, oldest
   *  first — the state the archived view renders as two cards. */
  async function archiveTwoVersions(name: string): Promise<{ older: number; newer: number }> {
    createProtocol(mkProtocol(name, { description: "OLDER" }));
    await call("DELETE", `/api/protocols/${name}`);
    await call("POST", "/api/protocols", { name, description: "NEWER" });
    await call("DELETE", `/api/protocols/${name}`);
    const stamps = loadArchived().filter((r) => r.protocol.name === name)
      .sort((a, b) => a.archivedTs - b.archivedTs);
    expect(stamps).toHaveLength(2);
    return { older: stamps[0].archivedTs, newer: stamps[1].archivedTs };
  }

  it("?archivedTs restores THAT version and leaves the sibling archived", async () => {
    // The UI renders one card per archived version. Without this the newest is
    // restored no matter which card was clicked.
    const { older } = await archiveTwoVersions("versioned");

    const res = await call("POST", `/api/protocols/versioned/unarchive?archivedTs=${older}`);
    expect(res.status).toBe(200);
    expect(res.json<{ protocol: Protocol }>().protocol.description).toBe("OLDER");

    expect(loadCustomProtocols().find((p) => p.name === "versioned")?.description).toBe("OLDER");
    const left = loadArchived().filter((r) => r.protocol.name === "versioned");
    expect(left.map((r) => r.protocol.description)).toEqual(["NEWER"]);
  });

  it("restores the NEWEST version when no stamp is given", async () => {
    await archiveTwoVersions("defaulted");

    const res = await call("POST", "/api/protocols/defaulted/unarchive");
    expect(res.status).toBe(200);
    expect(res.json<{ protocol: Protocol }>().protocol.description).toBe("NEWER");
    expect(loadArchived().filter((r) => r.protocol.name === "defaulted").map((r) => r.protocol.description))
      .toEqual(["OLDER"]);
  });

  it("404s for a stamp no archived version carries — and restores nothing", async () => {
    const { older, newer } = await archiveTwoVersions("wrong_stamp");

    const res = await call(`POST`, `/api/protocols/wrong_stamp/unarchive?archivedTs=${older - 5}`);
    expect(res.status).toBe(404);
    expect(res.json<{ ok: boolean }>().ok).toBe(false);
    // Nothing may be restored on a miss — falling back to "newest" would restore
    // a version the caller did not ask for.
    expect(loadCustomProtocols()).toHaveLength(0);
    expect(loadArchived().filter((r) => r.protocol.name === "wrong_stamp").map((r) => r.archivedTs).sort((a, b) => a - b))
      .toEqual([older, newer]);
  });

  it("400s on a non-numeric archivedTs instead of silently restoring the newest", async () => {
    await archiveTwoVersions("bad_stamp");
    const res = await call("POST", "/api/protocols/bad_stamp/unarchive?archivedTs=newest");
    expect(res.status).toBe(400);
    expect(loadCustomProtocols()).toHaveLength(0);
  });

  it("409s rather than clobbering a live protocol of the same name", async () => {
    createProtocol(mkProtocol("collide"));
    await call("DELETE", "/api/protocols/collide");
    createProtocol(mkProtocol("collide", { description: "a different, newer one" }));

    const res = await call("POST", "/api/protocols/collide/unarchive");
    expect(res.status).toBe(409);
    // The live copy and the archived copy both survive — nothing silently lost.
    expect(loadCustomProtocols().find((p) => p.name === "collide")?.description)
      .toBe("a different, newer one");
    expect(loadArchived()).toHaveLength(1);
  });
});

describe("authorship provenance on the HTTP write paths", () => {
  it("POST /api/protocols stamps the caller as the user author", async () => {
    const res = await call("POST", "/api/protocols", { name: "hand_written", description: "mine" });
    expect(res.status).toBe(200);
    const created = res.json<{ protocol: Protocol }>().protocol;
    expect(created.source?.authoredBy).toBe("user");
    expect(created.source?.authoredAt).toBeGreaterThan(0);
    expect(loadCustomProtocols().find((p) => p.name === "hand_written")?.source?.authoredBy).toBe("user");
  });

  it("POST create cannot forge agent authorship from the body", async () => {
    await call("POST", "/api/protocols", {
      name: "forgery", description: "x",
      source: { type: "custom", authoredBy: "agent", authoredFromSession: "not-real" },
    });
    const stored = loadCustomProtocols().find((p) => p.name === "forgery");
    expect(stored?.source?.authoredBy).toBe("user");
    expect(stored?.source?.authoredFromSession).toBeUndefined();
  });

  it("PATCH cannot forge agent authorship and preserves existing provenance", async () => {
    createProtocol(mkProtocol("patch_me", {
      source: { type: "custom", authoredBy: "user", authoredAt: 111 },
    }));
    const res = await call("PATCH", "/api/protocols/patch_me", {
      description: "edited",
      source: { type: "custom", authoredBy: "agent", authoredFromSession: "spoof" },
    });
    expect(res.status).toBe(200);
    const stored = loadCustomProtocols().find((p) => p.name === "patch_me");
    expect(stored?.description).toBe("edited");
    expect(stored?.source).toEqual({ type: "custom", authoredBy: "user", authoredAt: 111 });
  });

  it("PATCH cannot rename a protocol", async () => {
    // usage rows, the dedup embedding and archived.json all key on name, so a
    // rename over PATCH would strand every one of them.
    createProtocol(mkProtocol("stable_name"));
    const res = await call("PATCH", "/api/protocols/stable_name", { name: "renamed", description: "edited" });
    expect(res.status).toBe(200);
    expect(loadCustomProtocols().map((p) => p.name)).toEqual(["stable_name"]);
    expect(loadCustomProtocols()[0].description).toBe("edited");
  });

  it("forking an agent-authored protocol yields a USER-authored copy, not agent and not blank", async () => {
    createProtocol(mkProtocol("agent_original", {
      pinned: true,
      source: { type: "custom", authoredBy: "agent", authoredAt: 1_700_000_000_000, authoredFromSession: "sess-fork" },
    }));

    const res = await call("POST", "/api/protocols/agent_original/fork", { newName: "my_fork" });
    expect(res.status).toBe(200);
    const forked = res.json<{ protocol: Protocol }>().protocol;
    expect(forked.source?.authoredBy).toBe("user");
    // The authoring session of the ORIGINAL must not follow the copy — it would
    // attribute the user's fork to an agent run that never produced it.
    expect(forked.source?.authoredFromSession).toBeUndefined();
    expect(forked.source?.attribution).toBe("forked from agent_original");
    // Pinning exempts a protocol from auto-archive. That's a decision about the
    // original, not a property of its content — the copy must not inherit it.
    expect(forked.pinned).toBeFalsy();
    expect(loadCustomProtocols().find((p) => p.name === "my_fork")?.pinned).toBeFalsy();
  });

  it("forking a bundled protocol keeps upstream attribution fields", async () => {
    createProtocol(mkProtocol("upstreamish", {
      source: { type: "custom", repo: "acme/protocols", commit: "abc1234", license: "MIT" },
    }));
    const res = await call("POST", "/api/protocols/upstreamish/fork", { newName: "upstream_fork" });
    const forked = res.json<{ protocol: Protocol }>().protocol;
    expect(forked.source).toMatchObject({
      type: "custom", repo: "acme/protocols", commit: "abc1234", license: "MIT", authoredBy: "user",
    });
  });
});
