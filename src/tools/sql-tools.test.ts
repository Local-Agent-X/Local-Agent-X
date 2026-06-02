import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { sqlTools } from "./sql-tools.js";

// The data-bearing SQL tool outputs must be wrapped as untrusted external
// content (same defense as web_fetch) so SQLite contents flow through the
// exfil-chain / lineage detector downstream.
const BOUNDARY = "<<<EXTERNAL_UNTRUSTED_CONTENT";
const END_BOUNDARY = "<<<END_EXTERNAL_UNTRUSTED_CONTENT";

const tool = (name: string) => {
  const t = sqlTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-sql-tools-test-"));
  dbPath = join(dir, "fixture.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO widgets (id, name) VALUES (?, ?)").run(1, "alpha");
  db.prepare("INSERT INTO widgets (id, name) VALUES (?, ?)").run(2, "beta");
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sql tools taint their data output", () => {
  it("sql_query SELECT result is wrapped as external content", async () => {
    const res = await tool("sql_query").execute({
      database: dbPath,
      query: "SELECT * FROM widgets",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain(BOUNDARY);
    expect(res.content).toContain(END_BOUNDARY);
    expect(res.content).toContain("source: sql_query");
    // The actual rows survive the wrap.
    expect(res.content).toContain("alpha");
    expect(res.metadata?.rowCount).toBe(2);
  });

  it("sql_query mutation result is NOT wrapped (not data)", async () => {
    const res = await tool("sql_query").execute({
      database: dbPath,
      query: "UPDATE widgets SET name = 'gamma' WHERE id = 1",
      readonly: false,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain(BOUNDARY);
    expect(res.content).toMatch(/Query executed/);
  });

  it("sql_schema table list is wrapped as external content", async () => {
    const res = await tool("sql_schema").execute({ database: dbPath });
    expect(res.content).toContain(BOUNDARY);
    expect(res.content).toContain("source: sql_schema");
    expect(res.content).toContain("widgets");
  });

  it("sql_schema single-table detail is wrapped as external content", async () => {
    const res = await tool("sql_schema").execute({ database: dbPath, table: "widgets" });
    expect(res.content).toContain(BOUNDARY);
    expect(res.content).toContain("source: sql_schema");
    expect(res.content).toContain("name");
  });

  it("sql_explain plan is wrapped as external content", async () => {
    const res = await tool("sql_explain").execute({
      database: dbPath,
      query: "SELECT * FROM widgets",
    });
    expect(res.content).toContain(BOUNDARY);
    expect(res.content).toContain("source: sql_explain");
  });
});
