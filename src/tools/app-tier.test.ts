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

describe("classifyAppTier — full-stack", () => {
  it.each([
    "scaffold a vite react project",
    "build a Next.js app with SSR",
    "make an express backend with a few endpoints",
    "a full-stack notes app",
    "an app that stores users in postgres",
    "todo app backed by sqlite",
    "a react dashboard application",
    "wire up a graphql api server",
  ])("flags %j as full-stack", (prompt) => {
    expect(classifyAppTier(prompt)).toBe("full-stack");
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

describe("classifyAppTier — precedence", () => {
  it("compiled-native wins over full-stack signals (a rust web server)", () => {
    expect(classifyAppTier("a rust backend server with an api")).toBe("compiled-native");
  });
});

describe("tierLabel", () => {
  it("labels each tier", () => {
    expect(tierLabel("quick-html")).toMatch(/quick HTML/i);
    expect(tierLabel("full-stack")).toMatch(/full-stack/i);
    expect(tierLabel("compiled-native")).toMatch(/compiled/i);
  });
});
