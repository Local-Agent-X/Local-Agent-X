// The structure kit's language rows for the build-tool languages
// (kit/project-languages-toolchains.mjs): on a scratch project in each one's
// default layout, the roots come from the project file, a module is what the
// row says, an import becomes an edge between two modules, and tests are not
// source. The vendored copy is what every built project runs, so it is tested.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

type Ctx = unknown;
type Module = { key: string } | null;
const langs = (await import(new URL("./kit/project-languages.mjs", import.meta.url).href)) as {
  defaultRoots(repo: string): string[];
  walkSource(dir: string): string[];
  moduleOf(file: string, root: string, repo: string): Module;
  importContext(repo: string, roots: string[]): Ctx;
  importTargets(file: string, ctx: Ctx): string[];
  isTestPath(rel: string): boolean;
  languageOf(file: string): { id: string } | null;
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-kit-langs-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (rel: string, text = "") => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const posix = (p: string) => relative(dir, p).split(sep).join("/");

/** The modules and module→module edges the map would draw, tests left out. */
function graph() {
  const roots = langs.defaultRoots(dir).map((r) => resolve(dir, r));
  const ctx = langs.importContext(dir, roots);
  const moduleOfFile = new Map<string, string>();
  for (const root of roots) {
    for (const f of langs.walkSource(root)) {
      if (langs.isTestPath(posix(f))) continue;
      const m = langs.moduleOf(f, root, dir);
      if (m) moduleOfFile.set(f, m.key);
    }
  }
  const edges = new Set<string>();
  for (const [f, from] of moduleOfFile) {
    for (const t of langs.importTargets(f, ctx)) {
      const to = moduleOfFile.get(t);
      if (to && to !== from) edges.add(`${from} -> ${to}`);
    }
  }
  return { roots: langs.defaultRoots(dir), modules: [...new Set(moduleOfFile.values())].sort(), edges: [...edges].sort() };
}

describe("the toolchain language rows", () => {
  it("Kotlin in a Gradle subproject: the package root is followed down; an import of a top-level fun is an edge", () => {
    file("settings.gradle.kts", 'rootProject.name = "x"\n');
    const pkg = "app/src/main/java/com/acme/app";
    file(`${pkg}/MainActivity.kt`, "package com.acme.app\nimport com.acme.app.auth.login\n");
    file(`${pkg}/auth/Login.kt`, "package com.acme.app.auth\nimport com.acme.app.store.Db\nfun login() = Db()\n");
    file(`${pkg}/store/Db.kt`, "package com.acme.app.store\nclass Db\n");
    file("app/src/test/java/com/acme/app/auth/LoginTest.kt", "class LoginTest\n");
    expect(graph()).toEqual({ roots: [pkg], modules: [`${pkg}/auth`, `${pkg}/store`], edges: [`${pkg}/auth -> ${pkg}/store`] });
  });

  it("Java with Maven: a class import resolves to its file", () => {
    file("pom.xml", "<project/>\n");
    file("src/main/java/com/acme/auth/Login.java", "package com.acme.auth;\nimport com.acme.store.Db;\n");
    file("src/main/java/com/acme/store/Db.java", "package com.acme.store;\npublic class Db {}\n");
    const r = "src/main/java/com/acme";
    expect(graph()).toEqual({ roots: [r], modules: [`${r}/auth`, `${r}/store`], edges: [`${r}/auth -> ${r}/store`] });
  });

  it("Swift with SwiftPM: a target is a module and `import Target` is an edge; Tests/ and Package.swift are not source", () => {
    file("Package.swift", "// swift-tools-version:5.9\n");
    file("Sources/Auth/Login.swift", "import Store\npublic func login() {}\n");
    file("Sources/Store/Db.swift", "public struct Db {}\n");
    file("Tests/AuthTests/LoginTests.swift", "@testable import Auth\n");
    expect(graph()).toEqual({ roots: ["Sources"], modules: ["Sources/Auth", "Sources/Store"], edges: ["Sources/Auth -> Sources/Store"] });
    expect(langs.languageOf("Package.swift")?.id).toBe("swift");
  });

  it("C#: a .sln names the kind; a dotted project folder resolves its namespace", () => {
    file("Acme.sln");
    file("src/Acme.Api/Controllers/UsersController.cs", "using Acme.Core.Services;\nnamespace Acme.Api.Controllers;\n");
    file("src/Acme.Core/Services/UserService.cs", "namespace Acme.Core.Services;\n");
    expect(graph()).toEqual({ roots: ["src"], modules: ["src/Acme.Api", "src/Acme.Core"], edges: ["src/Acme.Api -> src/Acme.Core"] });
    expect(langs.isTestPath("tests/Acme.Api.Tests/UsersTests.cs")).toBe(true);
  });

  it("C++ with CMake: src and include are roots; quoted and angle includes resolve under them", () => {
    file("CMakeLists.txt", "project(x)\n");
    file("src/app/main.cpp", '#include "net/socket.h"\n#include <acme/api.h>\n#include <vector>\n');
    file("src/net/socket.h", "int open_socket();\n");
    file("include/acme/api.h", "int api();\n");
    expect(graph()).toEqual({
      roots: ["src", "include"],
      modules: ["include/acme", "src/app", "src/net"],
      edges: ["src/app -> include/acme", "src/app -> src/net"],
    });
  });

  it("Dart: lib/ is the root; package: and relative imports are edges", () => {
    file("pubspec.yaml", "name: acme\n");
    file("lib/main.dart", "import 'package:acme/screens/home.dart';\n");
    file("lib/screens/home.dart", "import '../services/api.dart';\nimport 'package:flutter/material.dart';\n");
    file("lib/services/api.dart", "class Api {}\n");
    file("test/home_test.dart", "void main() {}\n");
    expect(graph()).toEqual({ roots: ["lib"], modules: ["lib/screens", "lib/services"], edges: ["lib/screens -> lib/services"] });
  });

  it("a requirements.txt beside a CMakeLists.txt is still a C++ repo", () => {
    file("CMakeLists.txt");
    file("requirements.txt");
    expect(langs.defaultRoots(dir)).toEqual(["src"]);
    file("src/a.c");
    file("include/a.h");
    expect(langs.defaultRoots(dir)).toEqual(["src", "include"]);
  });
});
