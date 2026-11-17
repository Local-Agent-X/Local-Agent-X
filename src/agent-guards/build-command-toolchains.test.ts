// The verify command for Kotlin, Java, Swift, C#, C/C++ and Dart projects
// (build-command-toolchains.ts), found through detectBuildCommand the way the
// build-verify gate finds it: from the files an op edited.
import { describe, expect, it } from "vitest";
import { detectBuildCommand, type FsProbe } from "./build-command.js";

/** A fake tree: each key is a file that exists; folders exist through them. */
function probeOf(files: string[]): FsProbe {
  const all = new Set(files);
  for (const f of files) for (let d = f; d.lastIndexOf("/") > 0;) { d = d.slice(0, d.lastIndexOf("/")); all.add(d); }
  return {
    exists: (p) => all.has(p),
    readJson: () => null,
    list: (dir) => [...all].filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
  };
}

const win = process.platform === "win32";

describe("the toolchain projects' verify commands", () => {
  it("Gradle: a subproject's edit builds from the root that has settings.gradle; Android builds debug", () => {
    const probe = probeOf([
      "/a/settings.gradle.kts", "/a/build.gradle.kts", "/a/app/build.gradle.kts",
      "/a/app/src/main/AndroidManifest.xml", "/a/app/src/main/java/com/x/Main.kt",
    ]);
    expect(detectBuildCommand(["/a/app/src/main/java/com/x/Main.kt"], probe))
      .toEqual({ command: "gradle assembleDebug --console=plain -q", cwd: "/a", kind: "check", requires: ["gradle"] });
    const jvm = probeOf(["/b/settings.gradle.kts", "/b/lib/build.gradle.kts", "/b/lib/src/main/kotlin/A.kt"]);
    expect(detectBuildCommand(["/b/lib/src/main/kotlin/A.kt"], jvm)).toMatchObject({ command: "gradle assemble --console=plain -q", cwd: "/b" });
  });

  it("Gradle and Maven: the project's own wrapper runs, and needs nothing on PATH", () => {
    const wrapper = win ? "gradlew.bat" : "gradlew";
    const g = detectBuildCommand(["/a/src/main/java/A.java"], probeOf(["/a/settings.gradle", `/a/${wrapper}`, "/a/src/main/java/A.java"]));
    expect(g).toMatchObject({ command: `./${wrapper} assemble --console=plain -q`, requires: [] });
    const mvnw = win ? "mvnw.cmd" : "mvnw";
    expect(detectBuildCommand(["/m/src/main/java/A.java"], probeOf(["/m/pom.xml", `/m/${mvnw}`, "/m/src/main/java/A.java"])))
      .toMatchObject({ command: `./${mvnw} -q compile`, cwd: "/m", requires: [] });
  });

  it("Maven: a module's edit compiles from the parent pom", () => {
    const probe = probeOf(["/m/pom.xml", "/m/core/pom.xml", "/m/core/src/main/java/A.java"]);
    expect(detectBuildCommand(["/m/core/src/main/java/A.java"], probe))
      .toEqual({ command: "mvn -q compile", cwd: "/m", kind: "check", requires: ["mvn"] });
  });

  it("Swift: SwiftPM builds; an Xcode project builds its one .xcodeproj with signing off", () => {
    expect(detectBuildCommand(["/s/Sources/App/main.swift"], probeOf(["/s/Package.swift", "/s/Sources/App/main.swift"])))
      .toEqual({ command: "swift build", cwd: "/s", kind: "check", requires: ["swift"] });
    expect(detectBuildCommand(["/x/Acme/AcmeApp.swift"], probeOf(["/x/Acme.xcodeproj/project.pbxproj", "/x/Acme/AcmeApp.swift"])))
      .toEqual({ command: `xcodebuild -project "Acme.xcodeproj" build -quiet CODE_SIGNING_ALLOWED=NO`, cwd: "/x", kind: "check", requires: ["xcodebuild"] });
  });

  it("C#: the one solution builds, or the one project when there is no solution; two solutions are ambiguous", () => {
    expect(detectBuildCommand(["/c/Program.cs"], probeOf(["/c/Acme.sln", "/c/Api.csproj", "/c/Program.cs"])))
      .toEqual({ command: `dotnet build "Acme.sln" -nologo -v q`, cwd: "/c", kind: "check", requires: ["dotnet"] });
    expect(detectBuildCommand(["/d/Api/Program.cs"], probeOf(["/d/Api/Api.csproj", "/d/Api/Program.cs"]))?.command)
      .toBe(`dotnet build "Api.csproj" -nologo -v q`);
    expect(detectBuildCommand(["/e/Program.cs"], probeOf(["/e/A.sln", "/e/B.sln", "/e/Program.cs"]))).toBeNull();
  });

  it("CMake: a subfolder's edit builds from the top CMakeLists.txt, configuring first when there is no build yet", () => {
    const files = ["/p/CMakeLists.txt", "/p/src/CMakeLists.txt", "/p/src/net/socket.c"];
    expect(detectBuildCommand(["/p/src/net/socket.c"], probeOf(files)))
      .toEqual({ command: "cmake -S . -B build; cmake --build build", cwd: "/p", kind: "check", requires: ["cmake"] });
    expect(detectBuildCommand(["/p/src/net/socket.c"], probeOf([...files, "/p/build/CMakeCache.txt"]))?.command).toBe("cmake --build build");
  });

  it("Meson: sets up once, then compiles", () => {
    expect(detectBuildCommand(["/n/src/a.c"], probeOf(["/n/meson.build", "/n/src/a.c"])))
      .toEqual({ command: "meson setup builddir; meson compile -C builddir", cwd: "/n", kind: "check", requires: ["meson", "ninja"] });
  });

  it("Dart: analyze fails only on errors, resolving packages first; a Flutter app uses flutter", () => {
    expect(detectBuildCommand(["/d/lib/main.dart"], probeOf(["/d/pubspec.yaml", "/d/lib/main.dart"])))
      .toEqual({ command: "dart pub get; dart analyze --no-fatal-warnings", cwd: "/d", kind: "check", requires: ["dart"] });
    expect(detectBuildCommand(["/f/lib/main.dart"], probeOf(["/f/pubspec.yaml", "/f/.metadata", "/f/.dart_tool/package_config.json", "/f/lib/main.dart"])))
      .toEqual({ command: "flutter analyze --no-fatal-infos --no-fatal-warnings", cwd: "/f", kind: "check", requires: ["flutter"] });
  });

  it("never climbs out of the edited workspace app to a project above it", () => {
    const probe = probeOf(["/w/CMakeLists.txt", "/w/workspace/apps/tool/CMakeLists.txt", "/w/workspace/apps/tool/main.c"]);
    expect(detectBuildCommand(["/w/workspace/apps/tool/main.c"], probe, "/w/workspace")?.cwd).toBe("/w/workspace/apps/tool");
  });

  it("without a folder listing, a project named only by its .csproj is not found", () => {
    const { list: _list, ...noList } = probeOf(["/c/Api.csproj", "/c/Program.cs"]);
    expect(detectBuildCommand(["/c/Program.cs"], noList)).toBeNull();
  });
});
