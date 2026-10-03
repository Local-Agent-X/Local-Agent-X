import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { NOT_PUBLISH_TOOLS, PUBLISH_TOOLS, publishOperation, publishOperations } from "./publish-operation.js";
import { TOOLS } from "./tool-registry.js";

const BASE = resolve("/work/repo");
const bash = (command: string) => publishOperation("bash", { command, _cwd: BASE });

describe("publishOperation — shell commands that publish", () => {
  const PUBLISHES: Array<[string, string, string]> = [
    ["git push", "git-push", "git push"],
    ["git push origin main", "git-push", "git push origin main"],
    ["git push -u origin feature/x", "git-push", "git push -u origin feature/x"],
    ["git push --force origin main", "git-push", "git push --force origin main"],
    ["git -C sub push", "git-push", "git push"],
    ["git -c user.name=x push --tags", "git-push", "git push --tags"],
    ["npm publish", "package-publish", "npm publish"],
    ["pnpm publish --access public", "package-publish", "pnpm publish"],
    ["yarn publish", "package-publish", "yarn publish"],
    ["yarn npm publish", "package-publish", "yarn publish"],
    ["bun publish", "package-publish", "bun publish"],
    ["cargo publish", "package-publish", "cargo publish"],
    ["docker push acme/api:1.2", "package-publish", "docker push"],
    ["docker image push acme/api", "package-publish", "docker image push"],
    ["docker buildx build --push -t acme/api .", "package-publish", "docker buildx build --push"],
    ["gh release create v1.2.0 --notes x", "release", "gh release create"],
    ["gh pr merge --squash", "release", "gh pr merge"],
    ["vercel", "deploy", "vercel"],
    ["vercel --prod", "deploy", "vercel --prod"],
    ["vercel deploy", "deploy", "vercel deploy"],
    ["vercel deploy --prod --yes", "deploy", "vercel deploy --prod"],
    ["vercel ./dist", "deploy", "vercel"],
    ["vercel --scope acme --prod", "deploy", "vercel --prod"],
    ["npx vercel deploy", "deploy", "vercel deploy"],
    ["npx -y vercel@latest --prod", "deploy", "vercel --prod"],
    ["pnpm dlx wrangler deploy", "deploy", "wrangler deploy"],
    ["netlify deploy --prod --dir build", "deploy", "netlify deploy"],
    ["supabase functions deploy send-email", "deploy", "supabase functions deploy"],
    ["supabase db push", "deploy", "supabase db push"],
    ["wrangler deploy", "deploy", "wrangler deploy"],
    ["wrangler publish", "deploy", "wrangler publish"],
    ["wrangler pages deploy ./out", "deploy", "wrangler pages deploy"],
    ["firebase deploy --only hosting", "deploy", "firebase deploy"],
    ["fly deploy", "deploy", "fly deploy"],
    ["flyctl deploy --app acme", "deploy", "flyctl deploy"],
    ["eas submit -p ios", "deploy", "eas submit"],
    ["eas build --platform all --auto-submit", "deploy", "eas build --auto-submit"],
    ["eas update --branch production", "deploy", "eas update"],
    ["npm run deploy", "deploy", "npm run deploy"],
    ["pnpm run release:prod", "deploy", "pnpm run release:prod"],
    ["yarn deploy", "deploy", "yarn run deploy"],
    // Wrappers, chains, and nested shells all reach the real command word.
    ["cd site && vercel --prod", "deploy", "vercel --prod"],
    ["npm test && npm publish", "package-publish", "npm publish"],
    ["sudo docker push acme/api", "package-publish", "docker push"],
    ["env GIT_TRACE=1 git push", "git-push", "git push"],
    ["bash -c \"git push origin main\"", "git-push", "git push origin main"],
    ["powershell -Command \"vercel --prod\"", "deploy", "vercel --prod"],
    ["C:\\tools\\vercel.cmd deploy", "deploy", "vercel deploy"],
    // Redirections are not arguments: the dry run must get `origin main`, not `2>`.
    ["git push origin main 2>&1", "git-push", "git push origin main"],
    ["cd proj && git push origin main > push.log 2>&1", "git-push", "git push origin main"],
    ["git push 2>/dev/null origin main", "git-push", "git push origin main"],
    ["vercel --prod >deploy.log 2>&1", "deploy", "vercel --prod"],
  ];
  for (const [command, kind, label] of PUBLISHES) {
    it(`${command} → ${kind}`, () => {
      const op = bash(command);
      expect(op, command).not.toBeNull();
      expect(op!.kind).toBe(kind);
      expect(op!.label.startsWith(label), `${op!.label} starts with ${label}`).toBe(true);
    });
  }
});

describe("publishOperation — look-alikes that do NOT publish", () => {
  const NOT: string[] = [
    "git log --oneline",
    "git status",
    "git fetch origin",
    "git commit -m 'git push later'",
    "git push --dry-run",
    "git push -n origin main",
    "git push --help",
    "grep -rn deploy src",
    "echo \"git push\"",
    "echo npm publish",
    "cat deploy.sh",
    "npm install",
    "npm publish --dry-run",
    "cargo publish --dry-run",
    "npm run build",
    "npm run test:deploy-script-lint",
    "yarn install",
    "pnpm deploy ./out",
    "vercel whoami",
    "vercel --version",
    "vercel env pull",
    "vercel dev",
    "vercel logs acme.vercel.app",
    "netlify status",
    "supabase migration new add_users",
    "supabase start",
    "wrangler dev",
    "firebase emulators:start",
    "fly status",
    "eas build --platform ios",
    "docker build -t acme .",
    "docker pull node:20",
    "gh pr view 12",
    "gh release list",
    "gh pr create --fill",
    "ls deploy",
  ];
  for (const command of NOT) {
    it(`${command} → null`, () => {
      expect(bash(command)).toBeNull();
    });
  }

  it("non-shell tools are never recognized by their arguments", () => {
    expect(publishOperation("write", { path: "deploy.sh", content: "git push" })).toBeNull();
    expect(publishOperation("read", { path: "npm publish" })).toBeNull();
    expect(publishOperation("http_request", { url: "https://api.vercel.com/v13/deployments", method: "POST" })).toBeNull();
  });
});

describe("publishOperation — the directory the command publishes from", () => {
  it("defaults to the stamped _cwd", () => {
    expect(bash("git push")!.cwd).toBe(BASE);
  });

  it("follows cd, git -C, vercel --cwd and Set-Location", () => {
    expect(bash("cd site && vercel --prod")!.cwd).toBe(join(BASE, "site"));
    expect(bash("git -C packages/api push")!.cwd).toBe(join(BASE, "packages", "api"));
    expect(bash("vercel --cwd apps/web --prod")!.cwd).toBe(join(BASE, "apps", "web"));
    expect(bash("Set-Location -Path site; vercel deploy")!.cwd).toBe(join(BASE, "site"));
    expect(bash("cd a; cd ../b; git push")!.cwd).toBe(join(BASE, "b"));
  });

  it("a cd inside a nested shell body does not leak out of it", () => {
    const ops = publishOperations("bash", { command: "bash -c \"cd inner && git push\" && npm publish", _cwd: BASE });
    expect(ops.map((o) => [o.kind, o.cwd])).toEqual([
      ["git-push", join(BASE, "inner")],
      ["package-publish", BASE],
    ]);
  });

  it("marks a runtime-expanded directory as uncertain", () => {
    const op = bash("cd $APP_DIR && vercel --prod")!;
    expect(op.cwdUncertain).toBe(true);
    expect(op.cwd).toBe(BASE);
  });

  it("process_start is a shell spawner too", () => {
    expect(publishOperation("process_start", { command: "vercel --prod", cwd: BASE })?.kind).toBe("deploy");
  });

  it("keeps git push's arguments verbatim for the dry run", () => {
    expect(bash("git push -u origin HEAD:refs/heads/x")!.pushArgs).toEqual(["-u", "origin", "HEAD:refs/heads/x"]);
    // … minus the shell's own redirections, which git would read as refspecs.
    expect(bash("git push origin main 2>&1")!.pushArgs).toEqual(["origin", "main"]);
    expect(bash("git push origin main > push.log 2> err.log")!.pushArgs).toEqual(["origin", "main"]);
    expect(bash("git push --force-with-lease origin main &>/dev/null")!.pushArgs).toEqual(["--force-with-lease", "origin", "main"]);
  });

  it("gh pr merge records an explicit PR selector", () => {
    expect(bash("gh pr merge 42 --squash --subject 'ship it'")!.explicitTarget).toBe("42");
    expect(bash("gh pr merge --squash")!.explicitTarget).toBeUndefined();
  });

  it("reports every publish in a compound command, in order", () => {
    const ops = publishOperations("bash", { command: "git push && vercel --prod && npm publish", _cwd: BASE });
    expect(ops.map((o) => o.kind)).toEqual(["git-push", "deploy", "package-publish"]);
  });
});

describe("registered tools with publish-shaped names are classified on purpose", () => {
  it("every deploy/publish/release/push-named tool is in PUBLISH_TOOLS or NOT_PUBLISH_TOOLS", () => {
    const shaped = Object.keys(TOOLS).filter((name) => /deploy|publish|release|(^|_)push(_|$)/.test(name));
    const unclassified = shaped.filter((name) => !(name in PUBLISH_TOOLS) && !(name in NOT_PUBLISH_TOOLS));
    expect(unclassified, "classify these in src/publish-operation.ts").toEqual([]);
  });

  it("NOT_PUBLISH_TOOLS names only tools that exist", () => {
    for (const name of Object.keys(NOT_PUBLISH_TOOLS)) expect(TOOLS[name], name).toBeDefined();
  });
});
