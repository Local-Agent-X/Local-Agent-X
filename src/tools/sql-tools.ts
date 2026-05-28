import Database from "better-sqlite3";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";

function resolvePath(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

function toMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_No rows returned._";
  const cols = Object.keys(rows[0]);
  const header = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => String(r[c] ?? "NULL")).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function isSelect(query: string): boolean {
  return /^\s*SELECT\b/i.test(query);
}

/* ── sql_query ────────────────────────────────────────────────── */

const sqlQuery: ToolDefinition = {
  name: "sql_query",
  description:
    'Run a SQL query against a SQLite database. Default is read-only. Example: database="workspace/data.db", query="SELECT * FROM users LIMIT 10"',
  parameters: {
    type: "object",
    properties: {
      database: { type: "string", description: "Path to .db/.sqlite file" },
      query: { type: "string", description: "SQL query to execute" },
      readonly: { type: "boolean", description: "Open in read-only mode (default true)" },
    },
    required: ["database", "query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const dbPath = resolvePath(String(args.database));
    const query = String(args.query);
    const readonly = args.readonly !== false;

    if (readonly && !isSelect(query)) {
      return { content: "Error: Set readonly=false to allow mutations", isError: true };
    }

    let db: ReturnType<typeof Database> | undefined;
    try {
      db = new Database(dbPath, { readonly });

      if (isSelect(query)) {
        const rows = db.prepare(query).all() as Record<string, unknown>[];
        return {
          content: toMarkdownTable(rows),
          metadata: { rowCount: rows.length },
        };
      }

      const info = db.prepare(query).run();
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
      database: { type: "string", description: "Path to .db/.sqlite file" },
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
        return { content: `### ${table}\n\n${toMarkdownTable(rows)}` };
      }

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const rows = tables.map((t) => {
        const count = (db!.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get() as { cnt: number }).cnt;
        return { table: t.name, rows: count };
      });
      return { content: toMarkdownTable(rows) };
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
      database: { type: "string", description: "Path to .db/.sqlite file" },
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
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Record<string, unknown>[];
      return { content: toMarkdownTable(plan) };
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
