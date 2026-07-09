import { describe, it, expect } from "vitest";
import { classifyAppTier, tierLabel } from "./app-tier.js";

describe("classifyAppTier — compiled-native", () => {
  it.each([
    "build a rust raytracer that renders a sphere",
    "make me a rust image generator",
    "write a Go program that crawls a sitemap",
    "a golang binary that hashes files",
    "compile a c++ program for n-body simulation",
    "build a CLI in zig",
    "render this with cargo run",
  ])("flags %j as compiled-native", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("compiled-native");
  });

  it("does NOT treat plain JavaScript as compiled (java vs javascript)", () => {
    expect(classifyAppTier("a javascript todo list")).toBe("quick-html");
  });

  it("does NOT trip on the bare word 'go' in ordinary prose", () => {
    expect(classifyAppTier("a button that makes the timer go faster")).toBe("quick-html");
  });
});

describe("classifyAppTier — frontend-spa (build-step frontend, live dev server)", () => {
  it.each([
    "scaffold a vite react project",
    "build a Next.js app with SSR",
    "a react dashboard application",
    "make me a svelte kit site",
    "a vue frontend with vite",
  ])("flags %j as frontend-spa", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("frontend-spa");
  });
});

describe("classifyAppTier — full-stack (real backend, no build-step frontend)", () => {
  it.each([
    "make an express backend with a few endpoints",
    "a full-stack notes app",
    "an app that stores users in postgres",
    "todo app backed by sqlite",
    "wire up a graphql api server",
  ])("flags %j as full-stack", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("full-stack");
  });

  it("a bare unqualified 'backend' still implies full-stack", () => {
    expect(classifyAppTier("build me a backend with a few endpoints")).toBe("full-stack");
    expect(classifyAppTier("a server-side rendered notes app")).toBe("full-stack");
  });
});

describe("classifyAppTier — negated backend does NOT fake a full-stack app", () => {
  // The regression: a client-only React SPA whose brief says "no backend" tripped
  // the bare 'backend' word and routed to full-stack → the model shipped a faked
  // static index.html instead of a real Vite build.
  it.each([
    "Build a React web app — a finance tracker, all client-side (no backend; localStorage)",
    "a web app for budgeting, client-side only, no backend",
    "a client-side todo web app without a server",
    "a serverless single-page web app for notes",
  ])("routes %j to frontend-spa, not full-stack", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("frontend-spa");
  });

  it("a NAMED engine still wins full-stack even when the brief also says 'no backend'", () => {
    // Self-contradictory, but an explicit Postgres genuinely needs a server.
    expect(classifyAppTier("a client-side app, no backend, data in postgres")).toBe("full-stack");
    expect(classifyAppTier("no backend really — just an express server with two routes")).toBe("full-stack");
  });
});

describe("classifyAppTier — quick-html (the conservative default)", () => {
  it.each([
    "build a calculator that converts USD to crypto",
    "make me a kanban board",
    "a dashboard that shows my fastmail inbox",        // 'dashboard' alone must NOT force full-stack
    "a habit tracker with a database of my habits",     // bare 'database' must NOT force full-stack
    "a little db viewer for a list of recipes",         // bare 'db' must NOT force full-stack
    "a landing page for my coffee brand",
    "an api status widget that polls one endpoint",     // bare 'api' must NOT force full-stack
  ])("keeps %j as quick-html", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("quick-html");
  });

  it("defaults empty/garbage input to quick-html", () => {
    expect(classifyAppTier("")).toBe("quick-html");
    expect(classifyAppTier("asdf qwerty")).toBe("quick-html");
  });
});

describe("classifyAppTier — real-app phrasing (no framework named → frontend-spa)", () => {
  it.each([
    "an app for my mobile car wash with a landing page, dashboard, and login",  // the motivating case
    "a web app to manage salon bookings with user login",
    "a multi-page site with signup",
    "build me a SaaS for tracking invoices",
    "a progressive web app for my gym",
  ])("routes plain-English real-app %j to frontend-spa", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("frontend-spa");
  });

  it("a named backend engine still wins full-stack over real-app phrasing", () => {
    // "login" is a real-app signal, but "postgres" means a real backend — the
    // real-app gate is checked AFTER full-stack precisely so this stays full-stack.
    expect(classifyAppTier("a car wash app with login backed by postgres")).toBe("full-stack");
  });

  it.each([
    "build a calculator that converts USD to crypto",
    "a landing page for my coffee brand",
    "a spa booking page for my salon",   // 'spa' must NOT match the SPA app-platform signal
    "a habit tracker",
    "a dashboard that shows my fastmail inbox",
  ])("keeps genuinely-trivial static %j on quick-html", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("quick-html");
  });
});

describe("classifyAppTier — precedence", () => {
  it("compiled-native wins over full-stack signals (a rust web server)", () => {
    expect(classifyAppTier("a rust backend server with an api")).toBe("compiled-native");
  });

  it("frontend-spa wins over full-stack for a build-step frontend WITH a backend", () => {
    // Needs a frontend dev server (so skip the static seed) AND can add a
    // backend — the SPA path covers both, so it must win over full-stack.
    expect(classifyAppTier("a full-stack vite react app with an express backend")).toBe("frontend-spa");
  });
});

describe("tierLabel", () => {
  it("labels each tier", () => {
    expect(tierLabel("quick-html")).toMatch(/quick HTML/i);
    expect(tierLabel("full-stack")).toMatch(/full-stack/i);
    expect(tierLabel("frontend-spa")).toMatch(/frontend SPA/i);
    expect(tierLabel("compiled-native")).toMatch(/compiled/i);
  });
});
