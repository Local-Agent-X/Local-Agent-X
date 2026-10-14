import Database from "better-sqlite3";
import type { ToolDefinition, ToolResult } from "../types.js";
import { wrapExternalContent } from "../sanitize.js";
import { resolveAgentPath } from "../workspace/paths.js";

// Exported so the SecurityLayer gates the EXACT path these tools open
// (kernel-class-policy.ts). The canonical resolver the file tools use: a
// relative path is anchored to the workspace (a leading "workspace/" is the
// same place), "~" is the home dir. It used to resolve against the server's
// cwd, so the documented "workspace/data.db" named a file under the install
// dir on the desktop, where the workspace lives elsewhere.
export function resolvePath(p: string): string {
  return resolveAgentPath(p);
}

const PATH_DOC = "Path to the .db/.sqlite file — relative to the workspace, or absolute; ~ is your home.";

// Load the sqlite-vec (vec0) extension into a fresh connection so the SQL
// tools can read databases that use vector virtual tables — chiefly the
// memory store (~/.lax/memory.db), which the server process opens WITH vec0.
// Without this, any query/schema touching the vec0 tables fails with
// "no such module: vec0", breaking the agent's ability to inspect its own
// memory. Memoized + best-effort: if sqlite-vec isn't installed, plain SQL
// still works (only vec0 tables become unreadable, same as before).
let _vecLoad: ((db: unknown) => void) | null | undefined;
async function loadVecExtension(db: unknown): Promise<void> {
  if (_vecLoad === undefined) {
    try { _vecLoad = (await import("sqlite-vec")).load as (db: unknown) => void; }
    catch { _vecLoad = null; }
  }
  if (_vecLoad) { try { _vecLoad(db); } catch { /* extension load failed — plain SQL still works */ } }
}

function toMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_No rows returned._";
  const cols = Object.keys(rows[0]);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "NULL")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

// A read: SELECT, or a CTE (WITH … SELECT). The connection is opened read-only
// too, so a "WITH … INSERT" passing this gate is still refused by SQLite.
function isReadQuery(query: string): boolean {
  return /^\s*(?:SELECT|WITH)\b/i.test(query);
}

/* ── sql_query ────────────────────────────────────────────────── */

const sqlQuery: ToolDefinition = {
  name: "sql_query",
  description:
    "Run a SQL query against a SQLite database. Default is read-only: SELECT and WITH … SELECT run; anything else needs readonly=false. " +
    'A relative database path is under the workspace. Example: database="workspace/data.db", query="SELECT * FROM users LIMIT 10"',
  parameters: {
    type: "object",
    properties: {
      database: { type: "string", description: PATH_DOC },
      query: { type: "string", description: "SQL query to execute" },
      readonly: { type: "boolean", description: "Open in read-only mode (default true)" },
    },
    required: ["database", "query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dbPath = resolvePath(String(args.database));
    const query = String(args.query);
    const readonly = args.readonly !== false;

    if (readonly && !isReadQuery(query)) {
      return { content: "Error: Set readonly=false to allow mutations (SELECT and WITH … SELECT run read-only)", isError: true };
    }

    let db: ReturnType<typeof Database> | undefined;
    try {
      db = new Database(dbPath, { readonly });
      await loadVecExtension(db);

      const stmt = db.prepare(query);
      if (stmt.reader) {
        const rows = stmt.all() as Record<string, unknown>[];
        return {
          content: wrapExternalContent(toMarkdownTable(rows), "sql_query", {
            database: String(args.database),
          }),
          metadata: { rowCount: rows.length },
        };
      }

      const info = stmt.run();
      return {
        content: `Query executed. Changes: ${info.changes}`,
        metadata: { changes: info.changes },
      };
    } catch (err: unknown) {
      return { content: `SQL error: ${(err as Error).message}`, isError: true };
    } finally {
      db?.close();
    }
  },
};

/* ── sql_schema ───────────────────────────────────────────────── */

const sqlSchema: ToolDefinition = {
  name: "sql_schema",
  description:
    "Inspect the schema of a SQLite database. Lists tables or shows column details for a specific table.",
  parameters: {
    type: "object",
    properties: {
      database: { type: "string", description: PATH_DOC },
      table: { type: "string", description: "Table name (omit to list all tables)" },
    },
    required: ["database"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dbPath = resolvePath(String(args.database));
    const table = args.table ? String(args.table) : undefined;

    let db: ReturnType<typeof Database> | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      await loadVecExtension(db);

      if (table) {
        const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
          cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
        }[];
        if (cols.length === 0) return { content: `Table "${table}" not found.`, isError: true };

        const rows = cols.map((c) => ({
          column: c.name,
          type: c.type || "ANY",
          nullable: c.notnull ? "NO" : "YES",
          default: c.dflt_value ?? "",
          pk: c.pk ? "YES" : "",
        }));
        return {
          content: wrapExternalContent(`### ${table}\n\n${toMarkdownTable(rows)}`, "sql_schema", {
            database: String(args.database),
          }),
        };
      }

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const rows = tables.map((t) => {
        const count = (db!.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get() as { cnt: number }).cnt;
        return { table: t.name, rows: count };
      });
      return {
        content: wrapExternalContent(toMarkdownTable(rows), "sql_schema", {
          database: String(args.database),
        }),
      };
    } catch (err: unknown) {
      return { content: `Schema error: ${(err as Error).message}`, isError: true };
    } finally {
      db?.close();
    }
  },
};

/* ── sql_explain ──────────────────────────────────────────────── */

const sqlExplain: ToolDefinition = {
  name: "sql_explain",
  description:
    "Show the execution plan for a SQL query. Useful for understanding query performance.",
  parameters: {
    type: "object",
    properties: {
      database: { type: "string", description: PATH_DOC },
      query: { type: "string", description: "SQL query to explain" },
    },
    required: ["database", "query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dbPath = resolvePath(String(args.database));
    const query = String(args.query);

    let db: ReturnType<typeof Database> | undefined;
    try {
      db = new Database(dbPath, { readonly: true });
      await loadVecExtension(db);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Record<string, unknown>[];
      return {
        content: wrapExternalContent(toMarkdownTable(plan), "sql_explain", {
          database: String(args.database),
        }),
      };
    } catch (err: unknown) {
      return { content: `Explain error: ${(err as Error).message}`, isError: true };
    } finally {
      db?.close();
    }
  },
};

/* ── exports ──────────────────────────────────────────────────── */

export const sqlTools: ToolDefinition[] = [sqlQuery, sqlSchema, sqlExplain];
export function createSqlTools(): ToolDefinition[] {
  return sqlTools;
}
