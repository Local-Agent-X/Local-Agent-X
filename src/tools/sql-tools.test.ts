import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { resolvePath, sqlTools } from "./sql-tools.js";
import { workspaceRoot } from "../config.js";
import { resolveAgentPath } from "../workspace/paths.js";

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

  it("a CTE read (WITH … SELECT) runs read-only; a mutation still needs readonly=false", async () => {
    const cte = await tool("sql_query").execute({ database: dbPath, query: "WITH w AS (SELECT name FROM widgets) SELECT * FROM w ORDER BY name" });
    expect(cte.isError).toBeFalsy();
    expect(cte.content).toContain("beta");
    expect(cte.metadata?.rowCount).toBe(2);

    const del = await tool("sql_query").execute({ database: dbPath, query: "DELETE FROM widgets" });
    expect(del.isError).toBe(true);
    expect(del.content).toMatch(/readonly=false/);
    // A CTE that writes passes the text gate but not the read-only connection.
    const cteWrite = await tool("sql_query").execute({ database: dbPath, query: "WITH w AS (SELECT 1) DELETE FROM widgets" });
    expect(cteWrite.isError).toBe(true);
    expect(cteWrite.content).toMatch(/readonly/i);
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

// The documented example database="workspace/data.db" named a file under the
// server's cwd — on the desktop, the install dir, not the workspace. The path
// now goes through the canonical resolver the file tools and the gate use.
describe("sql tools resolve a relative database path against the workspace", () => {
  it("resolvePath is the canonical agent-path resolver", () => {
    expect(resolvePath("workspace/data.db", undefined)).toBe(resolveAgentPath("data.db"));
    expect(resolvePath("data.db", undefined)).toBe(resolveAgentPath("data.db"));
    expect(resolvePath("~/x.db", undefined)).toBe(resolveAgentPath("~/x.db"));
  });

  it("opens the workspace file the example names", async () => {
    mkdirSync(workspaceRoot(), { recursive: true });
    const wsDir = mkdtempSync(join(workspaceRoot(), "sql-rel-"));
    try {
      const abs = join(wsDir, "data.db");
      const db = new Database(abs);
      db.exec("CREATE TABLE t (id INTEGER)");
      db.close();
      const rel = `workspace/${relative(workspaceRoot(), abs).replace(/\\/g, "/")}`;
      const res = await tool("sql_schema").execute({ database: rel });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("| t ");
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});
