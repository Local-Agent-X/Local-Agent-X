/**
 * Rows of the language table (project-languages.mjs) for the languages whose
 * source layout a build tool sets: Gradle or Maven (Kotlin, Java), SwiftPM or
 * Xcode (Swift), .NET (C#), CMake or Meson (C/C++), pub (Dart). Each row has
 * the shape project-languages.mjs documents; that file is the only importer.
 *
 * What a module is, and the default source roots:
 *   Kotlin, Java  a top-level directory under the package root. The package
 *                 root is a source set (`src/main/kotlin`, `src/main/java`, in
 *                 a Multiplatform `src/<target>Main/kotlin`, in the repo or
 *                 in a Gradle subproject such as `app/`) followed
 *                 down its single-folder chain: `src/main/kotlin/com/acme/app`,
 *                 so `com/acme/app/auth/` is the module `auth`, not `com/`.
 *   Swift         a top-level directory under `Sources/` (a SwiftPM target),
 *                 or under the app folder an `<App>.xcodeproj` is named after.
 *   C#            a top-level directory under `src/` (a .NET project); without
 *                 `src/`, the folders holding a `.csproj` are the roots and a
 *                 module is a folder inside a project.
 *   C/C++         a top-level directory under `src/` and `include/`.
 *   Dart          a top-level directory under `lib/`.
 *
 * Import resolution (only imports inside the mapped tree count):
 *   Kotlin, Java  `import a.b.C` → a/b/C.kt | a/b/C.java under a source set,
 *                 else the package directory's files (a Kotlin top-level
 *                 function, a nested class, `import a.b.*`)
 *   Swift         `import Target` → that target folder's files
 *   C#            `using A.B;` → the folder the namespace names under a root,
 *                 trying project folders with dots (`src/Acme.Core/Services`
 *                 for `Acme.Core.Services`); by convention, not by the compiler
 *   C/C++         `#include "x.h"` beside the file or under a root;
 *                 `#include <x.h>` under a root only
 *   Dart          relative URIs and `package:<this package>/…` in import,
 *                 export and part directives
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { filesIn, firstFile, isDir, posix, topLevelDirModule } from "./language-paths.mjs";

const JVM_EXT = [".kt", ".java"];
const NOT_A_PACKAGE = new Set(["build", ".gradle", "node_modules", ".git", "out"]);

/** Follow a source set down while it holds one folder and no source file. */
function packageRoot(dir) {
	for (;;) {
		const entries = readdirSync(dir).filter((n) => !n.startsWith("."));
		const subs = entries.filter((n) => isDir(join(dir, n)) && !NOT_A_PACKAGE.has(n));
		if (subs.length !== 1 || entries.some((n) => JVM_EXT.some((e) => n.endsWith(e)))) return dir;
		dir = join(dir, subs[0]);
	}
}

/** A project's main source sets: src/main/{kotlin,java}, and a Kotlin
 *  Multiplatform project's src/<target>Main/kotlin. */
function mainSourceSets(project) {
	const src = join(project, "src");
	if (!isDir(src)) return [];
	const sets = readdirSync(src).filter((n) => n === "main" || /^\w+Main$/.test(n));
	return sets.flatMap((s) => ["kotlin", "java"].map((l) => join(src, s, l))).filter(isDir);
}

/** Before any code, the source set the row's language would create. */
const jvmRoots = (language) => (repo) => {
	const projects = [".", ...readdirSync(repo).filter((n) => !n.startsWith(".") && !NOT_A_PACKAGE.has(n) && isDir(join(repo, n)))];
	const roots = projects.flatMap((p) => mainSourceSets(join(repo, p))).map(packageRoot);
	return roots.length ? [...new Set(roots.map((r) => posix(relative(repo, r))))] : [`src/main/${language}`];
};

/** The source-set folders above each root, where a package path starts. */
const sourceSets = (ctx) => (ctx.jvmSets ??= [...new Set(ctx.roots.map((r) => {
	let d = r;
	while (d !== dirname(d) && !/[\\/]src[\\/][\w-]+[\\/](java|kotlin)$/.test(d)) d = dirname(d);
	return d === dirname(d) ? r : d;
}))]);

const JVM_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+\w+)?\s*;?\s*$/gm;

function jvmTargets(file, text, ctx) {
	const out = [];
	for (const m of text.matchAll(JVM_IMPORT)) {
		const segs = m[1].split(".");
		const lowest = m[2] ? segs.length : Math.max(1, segs.length - 2);
		find: for (let n = segs.length; n >= lowest; n--) {
			for (const set of sourceSets(ctx)) {
				const stem = join(set, ...segs.slice(0, n));
				const hit = !m[2] && firstFile(JVM_EXT.map((e) => stem + e));
				if (hit) { out.push(hit); break find; }
				if ((m[2] || n < segs.length) && isDir(stem)) { out.push(...filesIn(stem, JVM_EXT)); break find; }
			}
		}
	}
	return out;
}

function swiftRoots(repo) {
	if (existsSync(join(repo, "Sources"))) return ["Sources"];
	const project = readdirSync(repo).find((n) => n.endsWith(".xcodeproj"));
	const app = project && basename(project, ".xcodeproj");
	return app && isDir(join(repo, app)) ? [app] : ["Sources"];
}

const SWIFT_IMPORT = /^\s*(?:@testable\s+)?import\s+(?:(?:struct|class|enum|protocol|func|var|let|typealias)\s+)?(\w+)/gm;

const swiftTargets = (file, text, ctx) => [...text.matchAll(SWIFT_IMPORT)]
	.flatMap((m) => ctx.roots.flatMap((r) => filesIn(join(r, m[1]), [".swift"], { deep: true })));

function csharpRoots(repo) {
	if (existsSync(join(repo, "src"))) return ["src"];
	const projects = readdirSync(repo).filter((n) => isDir(join(repo, n)) && readdirSync(join(repo, n)).some((f) => f.endsWith(".csproj")));
	return projects.length ? projects : ["src"];
}

const CS_USING = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm;

function csharpTargets(file, text, ctx) {
	const out = [];
	for (const m of text.matchAll(CS_USING)) {
		const segs = m[1].split(".");
		// `Acme.Core.Services` → src/Acme.Core.Services, src/Acme.Core/Services, src/Acme/Core/Services.
		const dirs = ctx.roots.flatMap((r) => segs.map((_, j) => join(r, segs.slice(0, segs.length - j).join("."), ...segs.slice(segs.length - j))));
		const hit = dirs.find(isDir);
		if (hit) out.push(...filesIn(hit, [".cs"]));
	}
	return out;
}

const C_EXT = [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"];
const C_INCLUDE = /^\s*#\s*include\s*(?:"([^"]+)"|<([^>]+)>)/gm;

function cTargets(file, text, ctx) {
	const out = [];
	for (const m of text.matchAll(C_INCLUDE)) {
		const spec = m[1] ?? m[2];
		const beside = m[1] ? [join(dirname(file), spec)] : [];
		const hit = firstFile([...beside, ...ctx.roots.map((r) => join(r, spec)), join(ctx.repo, "include", spec)]);
		if (hit) out.push(hit);
	}
	return out;
}

const DART_DIRECTIVE = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm;

function dartTargets(file, text, ctx) {
	ctx.dartPackage ??= (() => {
		const pubspec = join(ctx.repo, "pubspec.yaml");
		return existsSync(pubspec) ? readFileSync(pubspec, "utf8").match(/^name:\s*(\S+)/m)?.[1] ?? "" : "";
	})();
	const out = [];
	for (const m of text.matchAll(DART_DIRECTIVE)) {
		const uri = m[1];
		const own = `package:${ctx.dartPackage}/`;
		const path = ctx.dartPackage && uri.startsWith(own) ? join(ctx.repo, "lib", uri.slice(own.length))
			: /^[a-z]+:/.test(uri) ? null : resolve(dirname(file), uri);
		const hit = path && firstFile([path]);
		if (hit) out.push(hit);
	}
	return out;
}

const always = () => true;

export const TOOLCHAIN_LANGUAGES = [
	{
		id: "kotlin",
		extensions: [".kt"],
		isSource: always,
		isTest: (base) => /Tests?\.kt$/.test(base),
		projectFiles: ["settings.gradle.kts", "build.gradle.kts"],
		roots: jvmRoots("kotlin"),
		buildOutputs: ["build", "out", ".gradle"],
		moduleOf: topLevelDirModule,
		imports: jvmTargets,
	},
	{
		id: "java",
		extensions: [".java"],
		isSource: always,
		isTest: (base) => /Tests?\.java$/.test(base),
		projectFiles: ["pom.xml", "settings.gradle", "build.gradle"],
		roots: jvmRoots("java"),
		buildOutputs: ["build", "out", "target", ".gradle"],
		moduleOf: topLevelDirModule,
		imports: jvmTargets,
	},
	{
		id: "swift",
		extensions: [".swift"],
		isSource: (name) => !/(^|[\\/])Package\.swift$/.test(name),
		isTest: (base) => /Tests?\.swift$/.test(base),
		projectFiles: ["Package.swift", /\.xcodeproj$/],
		roots: swiftRoots,
		buildOutputs: [".build", "DerivedData"],
		moduleOf: topLevelDirModule,
		imports: swiftTargets,
	},
	{
		id: "csharp",
		extensions: [".cs"],
		isSource: (name) => !/(\.g|\.designer|(^|[\\/])AssemblyInfo)\.cs$/i.test(name),
		isTest: (base) => /Tests?\.cs$/.test(base),
		projectFiles: [/\.slnx?$/, /\.csproj$/],
		roots: csharpRoots,
		buildOutputs: ["bin", "obj"],
		moduleOf: topLevelDirModule,
		imports: csharpTargets,
	},
	{
		id: "c",
		extensions: C_EXT,
		isSource: always,
		isTest: (base) => /(_tests?|_unittest)\.\w+$/.test(base) || /^test_/.test(base),
		projectFiles: ["CMakeLists.txt", "meson.build"],
		roots: (repo) => {
			const present = ["src", "include"].filter((d) => existsSync(join(repo, d)));
			return present.length ? present : ["src"];
		},
		buildOutputs: ["build", "out", "cmake-build-debug", "cmake-build-release"],
		moduleOf: topLevelDirModule,
		imports: cTargets,
	},
	{
		id: "dart",
		extensions: [".dart"],
		isSource: (name) => !/\.(g|freezed|mocks)\.dart$/.test(name),
		isTest: (base) => /_test\.dart$/.test(base),
		projectFiles: ["pubspec.yaml"],
		roots: () => ["lib"],
		buildOutputs: ["build", ".dart_tool"],
		moduleOf: topLevelDirModule,
		imports: dartTargets,
	},
];
