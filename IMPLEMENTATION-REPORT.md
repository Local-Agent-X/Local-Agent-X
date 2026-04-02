# Open Agent X: Claude Code-Level Tool Implementation Report

> Date: 2026-04-01
> Goal: Bring open-agent-x to feature parity with Claude Code's tool system,
> add MS Office integration, and leverage our existing memory + security stack.

---

## 1. Current State: Gap Analysis

### What Claude Code Has (40 tools)

| Category | Claude Code Tools | Open Agent X Status |
|----------|------------------|-------------------|
| **File System** | Read, Write, Edit, Glob, Grep | **HAVE** (read, write, edit, bash) |
| **Shell** | Bash, PowerShell | **HAVE** (bash with security) |
| **Web** | WebFetch, WebSearch | **HAVE** (web_fetch) — missing dedicated search |
| **Agent** | AgentTool (spawn/fork/resume subagents) | **HAVE** (agency system) — needs tool interface |
| **Planning** | EnterPlanMode, ExitPlanMode, TodoWrite | **MISSING** |
| **Git Worktree** | EnterWorktree, ExitWorktree | **MISSING** |
| **User Interaction** | AskUserQuestion, SendMessage | **PARTIAL** (no structured question tool) |
| **Task System** | TaskCreate, TaskGet, TaskUpdate, TaskList, TaskOutput, TaskStop | **MISSING** |
| **Notebooks** | NotebookEdit | **MISSING** |
| **MCP** | MCPTool, McpAuth, ListMcpResources, ReadMcpResource | **MISSING** |
| **Scheduling** | ScheduleCron, RemoteTrigger, Sleep | **PARTIAL** (have cron infra, no tool interface) |
| **Search** | ToolSearch (deferred tool loading) | **MISSING** |
| **Skills** | SkillTool (dynamic slash commands) | **MISSING** |
| **Config** | ConfigTool | **MISSING** |

### What We Want Beyond Claude Code

| Category | Tools Needed | Status |
|----------|-------------|--------|
| **MS Office** | Excel read/write/formula, Word create/edit, PowerPoint create/edit | **STUB** (spreadsheet-tools.ts) |
| **PDF** | Read, create, annotate, extract tables | **STUB** (pdf-tools.ts) |
| **Email** | Send, read, search, draft | **STUB** (email-tools.ts) |
| **Calendar** | Read, create events, check availability | **STUB** (calendar-tools.ts) |
| **Vision** | Screen capture, camera, OCR | **HAVE** (implemented) |
| **Browser** | Navigate, click, scrape, screenshot | **HAVE** (playwright-based) |
| **Image Gen** | Generate, edit images | **HAVE** (image-tools.ts) |
| **Database** | SQL query, schema inspect, migrate | **STUB** (sql-tools.ts) |

### Architectural Differences

| Aspect | Claude Code | Open Agent X |
|--------|------------|--------------|
| **Tool Interface** | Rich (permissions, concurrency, progress, UI rendering, search hints) | Simple (name, params, execute) |
| **Tool Loading** | Deferred — tools load on-demand via ToolSearch | Eager — all tools loaded upfront |
| **Concurrency** | Per-tool `isConcurrencySafe` flag, streaming executor | No concurrency model |
| **Permission Model** | Tool-level checkPermissions + hook system | 5-layer security pipeline (stronger) |
| **Result Budgeting** | Large results persisted to disk, preview returned | No budgeting — full results in context |
| **System Prompt** | Each tool contributes via `prompt()` method | Static tool descriptions via schema |

---

## 2. Architecture Upgrades

### 2.1 Enhanced Tool Interface

Our `ToolDefinition` is too simple. We need to extend it without breaking existing tools.

```typescript
// New: src/tool-interface.ts  (extends existing tool-sdk.ts)

interface EnhancedToolDefinition extends ToolDefinition {
  // ── Metadata ──
  category: ToolCategory;          // 'filesystem' | 'web' | 'agent' | 'office' | etc.
  tags?: string[];                 // For tool search: ['git', 'version-control']

  // ── Behavior Flags ──
  concurrencySafe?: boolean;       // Can run in parallel? (default: false)
  readOnly?: boolean;              // Pure read, no side effects?
  isDestructive?: boolean;         // Deletes/overwrites data?

  // ── Lifecycle ──
  isEnabled?: () => boolean;       // Dynamic enable/disable
  validateInput?: (args) => ValidationResult;  // Pre-execution check
  checkPermissions?: (args, ctx) => PermissionResult;  // Tool-level auth

  // ── Context Management ──
  maxResultSize?: number;          // Chars before truncation (default: 50000)
  prompt?: () => string;           // Contribute to system prompt

  // ── Deferred Loading ──
  defer?: boolean;                 // Don't include in initial tool list
  searchHint?: string;             // Keywords for tool discovery
}
```

**Migration path**: Existing `ToolDefinition` tools keep working. New fields are optional.
The `defineTool()` and `ToolBuilder` in tool-sdk.ts get new optional methods.

### 2.2 Tool Search / Deferred Loading

Claude Code's killer feature: only ~15 tools are sent to the LLM initially.
The rest are discoverable via a `tool_search` tool. This saves tokens massively.

```
Implementation:
  1. New file: src/tool-search.ts
  2. Tools with `defer: true` are excluded from the initial tool list
  3. A `tool_search` tool takes a query, fuzzy-matches against all registered
     tools by name + searchHint + tags, returns schemas for top matches
  4. Agent can then call the discovered tool in subsequent turns
```

### 2.3 Streaming Tool Executor with Concurrency

Current: tools run serially via `executeToolCalls()`.
Needed: parallel execution for concurrent-safe tools.

```
Implementation:
  Modify src/tool-executor.ts:
  1. Partition tool calls into concurrent-safe and serial buckets
  2. Run all concurrent-safe tools via Promise.all()
  3. Run serial tools sequentially
  4. Add progress callbacks for long-running tools
  5. Add abort signal propagation for cancellation
```

### 2.4 Result Budgeting

Large tool results (file reads, web fetches) can blow up context windows.

```
Implementation:
  1. In tool-executor.ts, after tool returns:
     - If result.content.length > tool.maxResultSize (default 50k chars):
       a. Write full result to /tmp/sax-results/{hash}.txt
       b. Return truncated preview + "Full result saved to disk"
     - This keeps context lean for long conversations
```

---

## 3. Implementation Phases

### Phase 1: Core Tool Parity (Foundation)

**Files to create/modify**: 6 new files, 3 modified

#### 1A. Glob Tool — `src/glob-tool.ts`
Currently bash handles `find`/`ls`. A dedicated glob tool is faster and safer.
```
- Uses: fast-glob or node:fs glob
- Input: { pattern: string, path?: string }
- Output: sorted file list with modification times
- Why: Agents waste tokens parsing ls output. Structured glob is cleaner.
```

#### 1B. Grep Tool — `src/grep-tool.ts`
Dedicated regex search across files, way better than bash grep.
```
- Uses: ripgrep child process (rg) or node-based fallback
- Input: { pattern: string, path?: string, glob?: string, output_mode: 'content'|'files'|'count' }
- Output: structured matches with file, line number, context
- Why: The #1 most-called tool in Claude Code. Critical for code navigation.
```

#### 1C. Web Search Tool — `src/web-search-tool.ts`
We have web_fetch but no search. Agents need to find URLs first.
```
- Uses: DuckDuckGo HTML API (no API key needed) or Brave Search API
- Input: { query: string, max_results?: number }
- Output: title, url, snippet for each result
- Integration: pairs with existing web_fetch for fetch-after-search flow
```

#### 1D. Ask User Tool — `src/ask-user-tool.ts`
Let the agent explicitly pause and ask the user a question.
```
- Input: { question: string, options?: string[] }
- Output: user's response
- Why: Better than the agent guessing. Claude Code uses this heavily.
```

#### 1E. Plan Mode Tools — `src/plan-tools.ts`
Enter/exit planning mode where agent can only read, not write.
```
- enter_plan_mode: switches agent to read-only tool set
- exit_plan_mode: restores full tool access
- Why: Lets agent research before committing to changes
```

#### 1F. Task Management Tools — `src/task-tools.ts`
Structured task tracking the agent can use internally.
```
- task_create: { description, parent_id? }
- task_update: { id, status, output? }
- task_list: { filter? }
- task_get: { id }
- Backed by: in-memory store or SQLite (we already have better-sqlite3)
- Why: Multi-step work needs tracking. Currently agents lose track.
```

---

### Phase 2: MS Office & Document Tools (Business Power)

**The big differentiator.** Claude Code can't do this. We can.

#### 2A. Excel/Spreadsheet Tools — `src/spreadsheet-tools.ts` (fill stub)

**Dependencies**: `exceljs` (MIT, pure JS, no native deps)

```
Tools to implement:
  spreadsheet_read
    - Input: { file_path, sheet?: string, range?: string }
    - Output: JSON array of rows, with headers
    - Handles: .xlsx, .csv

  spreadsheet_write
    - Input: { file_path, data: rows[], sheet?: string, headers?: string[] }
    - Creates or overwrites a sheet with structured data

  spreadsheet_edit
    - Input: { file_path, sheet, cell: "B5", value: any, formula?: string }
    - Modify individual cells or ranges

  spreadsheet_query
    - Input: { file_path, sheet, filter: { column, operator, value } }
    - SQL-like filtering on spreadsheet data
    - Output: matching rows as JSON

  spreadsheet_chart
    - Input: { file_path, sheet, type: 'bar'|'line'|'pie', data_range, title }
    - Add charts to existing workbooks

  spreadsheet_formula
    - Input: { file_path, sheet, cell, formula: "=SUM(A1:A10)" }
    - Insert Excel formulas
```

#### 2B. Word/Document Tools — `src/document-tools.ts` (new file)

**Dependencies**: `docx` (MIT, creates .docx) + `mammoth` (for reading .docx)

```
Tools to implement:
  document_create
    - Input: { file_path, title, content: MarkdownString }
    - Converts markdown to properly formatted .docx
    - Supports: headings, bold/italic, lists, tables, images

  document_read
    - Input: { file_path }
    - Output: extracted text + structure (headings, paragraphs, tables)
    - Handles: .docx, .doc (via textract fallback)

  document_edit
    - Input: { file_path, operations: [{type: 'replace', find, replace}, ...] }
    - Find/replace text, append sections, insert tables

  document_template
    - Input: { template_path, variables: Record<string, string> }
    - Mail-merge style: fill {{placeholders}} in a template .docx
    - Great for: contracts, invoices, reports
```

#### 2C. PowerPoint Tools — `src/presentation-tools.ts` (new file)

**Dependencies**: `pptxgenjs` (MIT, creates .pptx)

```
Tools to implement:
  presentation_create
    - Input: { file_path, title, slides: SlideSpec[] }
    - SlideSpec: { title, body?, bullets?, image_path?, layout: 'title'|'content'|'two-column' }

  presentation_read
    - Input: { file_path }
    - Output: slide-by-slide text extraction + structure

  presentation_add_slide
    - Input: { file_path, slide: SlideSpec, position?: number }
    - Append or insert slides into existing presentations

  presentation_from_outline
    - Input: { file_path, outline: string (markdown) }
    - Auto-generates a full deck from a markdown outline
    - Smart layout selection based on content structure
```

#### 2D. PDF Tools — `src/pdf-tools.ts` (fill stub)

**Dependencies**: `pdf-parse` (reading) + `pdfkit` (creation)

```
Tools to implement:
  pdf_read
    - Input: { file_path, pages?: string }
    - Output: extracted text per page + metadata

  pdf_create
    - Input: { file_path, content: MarkdownString }
    - Renders markdown to a clean PDF

  pdf_extract_tables
    - Input: { file_path, page?: number }
    - Output: tables as JSON arrays (uses heuristic row/column detection)

  pdf_merge
    - Input: { files: string[], output_path: string }
    - Combine multiple PDFs
```

---

### Phase 3: Communication & Integration Tools

#### 3A. Email Tools — `src/email-tools.ts` (fill stub)

**Dependencies**: `nodemailer` (sending) + `imapflow` (reading)

```
  email_send
    - Input: { to, subject, body, cc?, attachments?: string[] }
    - SMTP config from ~/.sax/email.json or env vars

  email_read
    - Input: { folder?: string, limit?: number, filter?: { from?, subject?, unread? } }
    - Read inbox via IMAP

  email_search
    - Input: { query: string, folder?: string }
    - Search email by content/sender/date

  email_draft
    - Input: { to, subject, body }
    - Save draft without sending (for user review)
```

#### 3B. Calendar Tools — `src/calendar-tools.ts` (fill stub)

**Dependencies**: Google Calendar API via `googleapis` or CalDAV

```
  calendar_list_events
    - Input: { start_date, end_date, calendar_id? }

  calendar_create_event
    - Input: { title, start, end, description?, attendees? }

  calendar_check_availability
    - Input: { date, duration_minutes }
    - Output: available time slots
```

#### 3C. SQL Tools — `src/sql-tools.ts` (fill stub)

**Dependencies**: `better-sqlite3` (already have), `pg`, `mysql2` for remote DBs

```
  sql_query
    - Input: { connection: string, query: string }
    - Safety: READ-ONLY by default, explicit flag for mutations

  sql_schema
    - Input: { connection: string, table?: string }
    - Output: table/column definitions

  sql_explain
    - Input: { connection: string, query: string }
    - Output: query execution plan
```

#### 3D. Clipboard Tools — `src/clipboard-tools.ts` (fill stub)

```
  clipboard_read — read system clipboard text/image
  clipboard_write — write to system clipboard
  Dependencies: clipboardy or native PowerShell/pbcopy
```

---

### Phase 4: Agent Orchestration Tools

#### 4A. Agent Spawn Tool — `src/agent-spawn-tool.ts`

Expose the existing agency system as a tool the LLM can call.
```
  agent_spawn
    - Input: { role: AgentRole, task: string, tools?: string[], background?: boolean }
    - Creates a subagent via agency-orchestrator
    - Returns: agent_id for tracking

  agent_message
    - Input: { agent_id: string, message: string }
    - Send follow-up instructions to a running agent

  agent_status
    - Input: { agent_id?: string }
    - List running agents and their status/output
```

This is how Claude Code's AgentTool works — the LLM decides when to delegate.

#### 4B. Cron/Schedule Tool — `src/schedule-tool.ts`

Expose existing cron infrastructure as a tool.
```
  schedule_create
    - Input: { cron: string, task: string, name?: string }

  schedule_list — show all scheduled tasks
  schedule_delete — remove a scheduled task
```

---

### Phase 5: Smart Integration Layer

#### 5A. Tool Search — `src/tool-search.ts`

```
  tool_search
    - Input: { query: string, max_results?: number }
    - Fuzzy matches against all registered tools (including deferred ones)
    - Returns: tool name, description, parameter schema
    - After this call, the matched tools become available for the agent to use
```

#### 5B. Config Tool — `src/config-tool.ts`

```
  config_get — read agent/session configuration
  config_set — modify configuration at runtime
  Backed by: ~/.sax/config.json
```

#### 5C. Notebook Tool — `src/notebook-tool.ts`

```
  notebook_edit
    - Input: { file_path, cell_index, new_source, cell_type? }
    - Edit Jupyter .ipynb cells
    - Why: Data science workflows. Pairs well with spreadsheet tools.
```

---

## 4. System Prompt Engineering

Claude Code's secret weapon: each tool contributes to the system prompt via a `prompt()` method.
This gives the LLM detailed usage instructions beyond the JSON schema.

### Implementation

In `src/tool-executor.ts` or a new `src/tool-prompt-builder.ts`:

```typescript
function buildToolPromptSection(tools: EnhancedToolDefinition[]): string {
  const sections = tools
    .filter(t => t.prompt)
    .map(t => t.prompt!())
    .filter(Boolean);

  return sections.length
    ? `# Available Tool Guidance\n\n${sections.join('\n\n')}`
    : '';
}
```

Each tool's `prompt()` returns natural-language instructions like:
```
"When reading files, prefer the read tool over bash cat.
 Use offset/limit for large files instead of reading everything."
```

This gets appended to the system prompt, teaching the agent best practices.

---

## 5. Memory System Integration

Our existing memory system (14+ modules) is already ahead of Claude Code's `memdir/`.
Here's how tools integrate with it:

### Tool Usage Memory
```
After tool execution, feed results into memory system:
  - memory-graph: link tool outputs to entities (files, people, projects)
  - emotional-memory: track which tools frustrated the user (errors, retries)
  - compression: summarize large tool outputs for long-term recall
  - consolidation: merge repeated tool patterns into learned preferences
```

### Example Flow
```
1. User asks agent to "prepare the quarterly report"
2. Agent uses tool_search → finds spreadsheet_read, document_create, pdf_create
3. Agent reads Q1-data.xlsx → memory stores the file structure
4. Agent creates report.docx from the data
5. Agent converts to report.pdf
6. Memory records: "user keeps quarterly data in ~/reports/Q{n}-data.xlsx"
7. Next quarter, agent already knows where to look
```

---

## 6. Dependency Summary

New npm packages needed:

| Package | Purpose | Size | License |
|---------|---------|------|---------|
| `exceljs` | Excel read/write/charts | 2.4MB | MIT |
| `docx` | Word document creation | 1.1MB | MIT |
| `mammoth` | Word document reading | 390KB | BSD-2 |
| `pptxgenjs` | PowerPoint creation | 1.8MB | MIT |
| `pdf-parse` | PDF reading | 96KB | MIT |
| `pdfkit` | PDF creation | 1.2MB | MIT |
| `pdf-lib` | PDF manipulation/merge | 1.5MB | MIT |
| `fast-glob` | File globbing | 42KB | MIT |
| `nodemailer` | Email sending | 196KB | MIT |
| `imapflow` | Email reading (IMAP) | 312KB | MIT |
| `clipboardy` | Clipboard access | 12KB | MIT |

**Total additional**: ~9MB (all pure JS, no native compilation needed)

---

## 7. Priority Order & Estimated Effort

### Sprint 1: Foundation (highest impact)
1. Enhanced tool interface (tool-interface.ts) — extend, don't replace
2. Glob tool — simple, high usage
3. Grep tool — the most important single tool
4. Web search tool — unlocks research workflows
5. Tool search / deferred loading — token savings
6. Result budgeting in tool-executor.ts

### Sprint 2: Office Suite (differentiator)
7. Excel/spreadsheet tools (exceljs)
8. Word/document tools (docx + mammoth)
9. PowerPoint tools (pptxgenjs)
10. PDF tools (pdf-parse + pdfkit)

### Sprint 3: Communication
11. Email tools (nodemailer + imapflow)
12. Calendar tools
13. Clipboard tools

### Sprint 4: Agent Intelligence
14. Task management tools (SQLite-backed)
15. Agent spawn tool (expose agency system)
16. Plan mode tools
17. Schedule/cron tool
18. Ask user tool
19. Config tool

### Sprint 5: Polish
20. Tool prompt builder (system prompt contributions)
21. Memory integration hooks
22. Notebook editing
23. Streaming progress for long-running tools

---

## 8. File Structure After Implementation

```
src/
  ── Tool Infrastructure ──
  tool-sdk.ts              (existing — extend with new interface)
  tool-interface.ts        (NEW — EnhancedToolDefinition)
  tool-executor.ts         (existing — add concurrency + budgeting)
  tool-search.ts           (NEW — deferred tool discovery)
  tool-prompt-builder.ts   (NEW — system prompt contributions)
  tool-policy.ts           (existing)
  tool-rate-limiter.ts     (existing)
  tool-timeout.ts          (existing)
  tool-tracker.ts          (existing)

  ── Core Tools (Sprint 1) ──
  tools.ts                 (existing — read, write, edit, bash, web_fetch, etc.)
  glob-tool.ts             (NEW)
  grep-tool.ts             (NEW)
  web-search-tool.ts       (NEW)
  ask-user-tool.ts         (NEW)
  plan-tools.ts            (NEW)
  task-tools.ts            (NEW)
  config-tool.ts           (NEW)

  ── Office Suite (Sprint 2) ──
  spreadsheet-tools.ts     (existing stub → implement)
  document-tools.ts        (NEW — Word)
  presentation-tools.ts    (NEW — PowerPoint)
  pdf-tools.ts             (existing stub → implement)

  ── Communication (Sprint 3) ──
  email-tools.ts           (existing stub → implement)
  calendar-tools.ts        (existing stub → implement)
  clipboard-tools.ts       (existing stub → implement)

  ── Agent Tools (Sprint 4) ──
  agent-spawn-tool.ts      (NEW — expose agency system as tool)
  schedule-tool.ts         (NEW — expose cron as tool)

  ── Existing (keep) ──
  browser-tools.ts         (Playwright — already working)
  image-tools.ts           (generation — already working)
  youtube-tool.ts          (analysis — already working)
  app-tools.ts             (app creation — already working)
  issue-tools.ts           (GitHub/Linear — already working)
```

---

## 9. Key Design Principles

1. **Clean-room implementation** — Inspired by Claude Code's architecture,
   not copied from their source. Our own interfaces, our own code.

2. **Backwards compatible** — New `EnhancedToolDefinition` extends existing
   `ToolDefinition`. All 12 current tools keep working unchanged.

3. **Security first** — Every new tool goes through our existing 5-layer
   security pipeline (AriKernel → Session → Security → RBAC → Policy → Threat).
   Claude Code has nothing this strong.

4. **Deferred by default** — Office, email, calendar tools are deferred.
   Only core tools (read, write, edit, bash, glob, grep) load eagerly.
   Tool search discovers the rest on demand.

5. **Provider agnostic** — Tools work with any LLM backend (Claude, GPT, Grok,
   Gemini, local). Tool schemas convert to both OpenAI and Anthropic formats.

6. **Memory-aware** — Tool results feed into our memory system. The agent
   learns from past tool usage patterns across sessions.
