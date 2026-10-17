// The server (src/, ESM) and the Electron main process (desktop/src/, CJS)
// cannot import each other, so what they must agree on is declared once in
// src/desktop-contract/ and copied into desktop/src/contract/. These hold the
// two sides to the contract: the copy is current, every IPC message type
// either side keys on is declared, every environment variable the desktop
// hands the server is read by its declared name, the data directory is
// resolved by the one resolver on both sides, and the rollback journal the
// server writes is what the desktop's heal accepts.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fg from "fast-glob";
import { contractDrift } from "../scripts/check-desktop-contract.mjs";
import { BROWSER_MESSAGE_TYPES, BROWSER_PUSH_TYPES, BROWSER_RESULT_TYPES } from "../src/desktop-contract/browser-bridge.js";
import { MAIN_TO_SERVER_TYPES, SERVER_TO_MAIN_TYPES } from "../src/desktop-contract/ipc.js";
import { DESKTOP_ENV } from "../src/desktop-contract/env.js";
import { EXIT_ALREADY_RUNNING } from "../src/desktop-contract/exit-codes.js";
import { validJournal as desktopValidJournal } from "../desktop/src/contract/rollback-journal.js";
import { createJournal, directoryIdentity } from "../src/update-rollback-state.js";
import { healWedgedRollbackJournal } from "../desktop/src/rollback-journal-heal.js";
import { ROLLBACK_DIR, ROLLBACK_JOURNAL_FILE } from "../src/desktop-contract/data-dir.js";

const SOURCES = fg.sync(["src/**/*.ts", "desktop/src/**/*.ts"], {
  ignore: ["**/*.test.ts", "**/*.test-helper.ts", "**/vendor/**", "src/desktop-contract/**", "desktop/src/contract/**"],
});
const read = (file: string) => readFileSync(file, "utf-8");

describe("the desktop copy of the contract", () => {
  it("is what scripts/check-desktop-contract.mjs --sync would write", () => {
    expect(contractDrift()).toEqual([]);
  });
});

describe("every IPC message type either side keys on is declared", () => {
  const declared = new Set<string>([
    ...SERVER_TO_MAIN_TYPES, ...MAIN_TO_SERVER_TYPES, ...BROWSER_MESSAGE_TYPES, ...BROWSER_RESULT_TYPES, ...BROWSER_PUSH_TYPES,
  ]);

  it("no `lax:` literal outside the declared sets", () => {
    const undeclared: string[] = [];
    for (const file of SOURCES) {
      for (const m of read(file).matchAll(/"(lax:[a-z-]+)"/g)) {
        if (!declared.has(m[1])) undeclared.push(`${file}: ${m[1]}`);
      }
    }
    expect(undeclared, "declare the message in src/desktop-contract/ipc.ts or browser-bridge.ts").toEqual([]);
  });

  // A declared type nobody sends is a dead contract entry; one nobody
  // handles is a message that vanishes. The browser result types are the one
  // family a side consumes by set (bridge-client settles them by id through
  // RESULT_TYPES), so they are checked on their sender only.
  it("every declared type is sent by its side and handled by the other", () => {
    const server = SOURCES.filter((f) => f.startsWith("src")).map(read).join("\n");
    const desktop = SOURCES.filter((f) => f.startsWith("desktop")).map(read).join("\n");
    const literal = (side: string, type: string) => side.includes(`"${type}"`);
    for (const type of [...SERVER_TO_MAIN_TYPES, ...BROWSER_MESSAGE_TYPES]) {
      expect(literal(server, type), `${type} sent by the server`).toBe(true);
      expect(literal(desktop, type), `${type} handled by the desktop`).toBe(true);
    }
    for (const type of [...MAIN_TO_SERVER_TYPES, ...BROWSER_PUSH_TYPES]) {
      expect(literal(desktop, type), `${type} sent by the desktop`).toBe(true);
      expect(literal(server, type), `${type} handled by the server`).toBe(true);
    }
    for (const type of BROWSER_RESULT_TYPES) expect(literal(desktop, type), `${type} sent by the desktop`).toBe(true);
  });
});

describe("the environment the desktop hands the server", () => {
  it("is read and set by its declared name only", () => {
    const names = Object.values(DESKTOP_ENV).filter((n) => n !== DESKTOP_ENV.DATA_DIR);
    const literal = new RegExp(`(process\\.env\\.|["'])(${names.join("|")})\\b`);
    const offenders = SOURCES.filter((f) => literal.test(read(f))).map((f) => `${f}: ${literal.exec(read(f))![2]}`);
    expect(offenders, "read it as process.env[DESKTOP_ENV.X] and set it as [DESKTOP_ENV.X]").toEqual([]);
  });
});

describe("the data directory", () => {
  it("is resolved by the contract on the desktop side: no `~/.lax` literal outside it", () => {
    const offenders = SOURCES.filter((f) => f.startsWith("desktop") && /["'`]\.lax["'`/]/.test(read(f)));
    expect(offenders, "use laxDataDir() / the path helpers in contract/data-dir.ts").toEqual([]);
  });

  it("the already-running exit code is one constant on both sides", () => {
    const offenders = SOURCES.filter((f) => /(exit\(|code === |code !== )75\b/.test(read(f)));
    expect(offenders, `use EXIT_ALREADY_RUNNING (${EXIT_ALREADY_RUNNING})`).toEqual([]);
  });
});

describe("the rollback journal", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

  it("what the server writes, the desktop's heal leaves alone; what it would not accept, the heal moves aside", () => {
    const lax = mkdtempSync(join(tmpdir(), "lax-contract-"));
    roots.push(lax);
    const install = join(lax, "install");
    mkdirSync(install, { recursive: true });
    mkdirSync(join(lax, ROLLBACK_DIR), { recursive: true });
    const journal = createJournal(install, lax, "a".repeat(40), "b".repeat(40), [], directoryIdentity(install), directoryIdentity(lax));
    expect(desktopValidJournal(journal)).toBe(true);
    writeFileSync(join(lax, ROLLBACK_DIR, ROLLBACK_JOURNAL_FILE), JSON.stringify(journal));
    expect(healWedgedRollbackJournal(lax)).toBeNull();

    writeFileSync(join(lax, ROLLBACK_DIR, ROLLBACK_JOURNAL_FILE), JSON.stringify({ ...journal, entries: [{ path: "../escape", existed: true, sha256: null }] }));
    expect(healWedgedRollbackJournal(lax)).toMatch(/update-rollback-superseded[\\/]heal-/);
  });
});
