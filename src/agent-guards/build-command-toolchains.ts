// The verify command for a project whose build tool is not Node, Cargo or Go:
// Gradle or Maven (Kotlin, Java), SwiftPM or Xcode (Swift), .NET (C#), CMake or
// Meson (C/C++), and pub (Dart, Flutter). build-command.ts finds the project
// directory and asks here; each answer names the program it needs, so the gate
// can say a check was skipped on a computer without that toolchain instead of
// calling the agent's edit broken.
//
// Each command checks that the code compiles (or, for Dart, analyzes clean of
// errors) and nothing more: no tests, no release packaging. A command that runs
// two steps joins them with `;`, which bash and every PowerShell parse; `&&`
// is a parse error in Windows PowerShell 5.1, the harness's last-resort shell.

import type { BuildCommand, FsProbe } from "./build-command.js";

const GRADLE_FILES = ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"];

/** Files that mark a directory as one of these projects. */
const TOOLCHAIN_MANIFESTS = [...GRADLE_FILES, "pom.xml", "Package.swift", "CMakeLists.txt", "meson.build", "pubspec.yaml"];

/** Project files a project names after itself (`App.csproj`, `App.xcodeproj`). */
const NAMED_PROJECT = /\.(csproj|slnx?|xcodeproj)$/;

const IS_WINDOWS = process.platform === "win32";

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + "/" + name;
}

function parentOf(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut <= 0 ? trimmed : trimmed.slice(0, cut);
}

const has = (fs: FsProbe, dir: string, name: string) => fs.exists(joinPath(dir, name));
const listed = (fs: FsProbe, dir: string) => fs.list?.(dir) ?? [];

/** Whether the directory holds one of these projects' files. */
export function isToolchainProjectDir(dir: string, fs: FsProbe): boolean {
  return TOOLCHAIN_MANIFESTS.some((m) => has(fs, dir, m)) || listed(fs, dir).some((n) => NAMED_PROJECT.test(n));
}

/** The topmost of a run of directories holding one of `markers`, from `dir`
 *  upward, never above the directory `isCeiling` names (the edited app's own
 *  folder, when there is one). */
function climb(dir: string, fs: FsProbe, markers: string[], isCeiling: (d: string) => boolean): string {
  let best = dir;
  for (let d = dir; !isCeiling(d);) {
    const up = parentOf(d);
    if (up === d || !markers.some((m) => has(fs, up, m))) break;
    best = d = up;
  }
  return best;
}

/**
 * The directory the build tool runs from, for a project directory found by
 * walking up from an edited file. A Gradle or Maven subproject builds from its
 * root (where `settings.gradle` or the parent `pom.xml` is); a CMake or Meson
 * project from its top folder, since every subfolder has its own
 * CMakeLists.txt / meson.build. Anything else builds where it was found.
 */
export function toolchainRoot(dir: string, fs: FsProbe, isCeiling: (d: string) => boolean): string {
  if (GRADLE_FILES.some((m) => has(fs, dir, m))) return climb(dir, fs, ["settings.gradle.kts", "settings.gradle"], isCeiling);
  for (const marker of ["pom.xml", "CMakeLists.txt", "meson.build"]) {
    if (has(fs, dir, marker)) return climb(dir, fs, [marker], isCeiling);
  }
  return dir;
}

/** The project's own wrapper when it ships one, else the tool on PATH. */
function wrapperOr(dir: string, fs: FsProbe, wrapper: string, windowsWrapper: string, tool: string): { run: string; requires: string[] } {
  if (IS_WINDOWS && has(fs, dir, windowsWrapper)) return { run: `./${windowsWrapper}`, requires: [] };
  if (!IS_WINDOWS && has(fs, dir, wrapper)) return { run: `./${wrapper}`, requires: [] };
  return { run: tool, requires: [tool] };
}

const check = (command: string, cwd: string, requires: string[]): BuildCommand => ({ command, cwd, kind: "check", requires });

function gradleCommand(dir: string, fs: FsProbe): BuildCommand {
  const g = wrapperOr(dir, fs, "gradlew", "gradlew.bat", "gradle");
  // An Android app has no release signing on a dev machine; its debug build is the compile check.
  const android = has(fs, dir, "src/main/AndroidManifest.xml") || has(fs, dir, "app/src/main/AndroidManifest.xml");
  return check(`${g.run} ${android ? "assembleDebug" : "assemble"} --console=plain -q`, dir, g.requires);
}

function dotnetCommand(dir: string, names: string[]): BuildCommand | null {
  const solutions = names.filter((n) => /\.slnx?$/.test(n));
  const projects = names.filter((n) => n.endsWith(".csproj"));
  const target = solutions.length === 1 ? solutions[0] : solutions.length === 0 && projects.length === 1 ? projects[0] : null;
  return target ? check(`dotnet build "${target}" -nologo -v q`, dir, ["dotnet"]) : null;
}

function dartCommand(dir: string, fs: FsProbe): BuildCommand {
  // `flutter create` writes .metadata; a Flutter app's packages resolve only through flutter.
  const tool = has(fs, dir, ".metadata") ? "flutter" : "dart";
  const resolve = has(fs, dir, ".dart_tool/package_config.json") ? "" : `${tool} pub get; `;
  const analyze = tool === "flutter" ? "flutter analyze --no-fatal-infos --no-fatal-warnings" : "dart analyze --no-fatal-warnings";
  return check(resolve + analyze, dir, [tool]);
}

/** The verify command for a toolchain project directory, or null when the
 *  directory is not one, or names its target ambiguously (two solutions). */
export function toolchainCommand(dir: string, fs: FsProbe): BuildCommand | null {
  if (GRADLE_FILES.some((m) => has(fs, dir, m))) return gradleCommand(dir, fs);
  if (has(fs, dir, "pom.xml")) {
    const m = wrapperOr(dir, fs, "mvnw", "mvnw.cmd", "mvn");
    return check(`${m.run} -q compile`, dir, m.requires);
  }
  if (has(fs, dir, "Package.swift")) return check("swift build", dir, ["swift"]);
  if (has(fs, dir, "pubspec.yaml")) return dartCommand(dir, fs);
  if (has(fs, dir, "CMakeLists.txt")) {
    const configure = has(fs, dir, "build/CMakeCache.txt") ? "" : "cmake -S . -B build; ";
    return check(`${configure}cmake --build build`, dir, ["cmake"]);
  }
  if (has(fs, dir, "meson.build")) {
    const setup = has(fs, dir, "builddir/build.ninja") ? "" : "meson setup builddir; ";
    return check(`${setup}meson compile -C builddir`, dir, ["meson", "ninja"]);
  }
  const names = listed(fs, dir);
  const xcode = names.filter((n) => n.endsWith(".xcodeproj"));
  if (xcode.length === 1) return check(`xcodebuild -project "${xcode[0]}" build -quiet CODE_SIGNING_ALLOWED=NO`, dir, ["xcodebuild"]);
  return dotnetCommand(dir, names);
}
