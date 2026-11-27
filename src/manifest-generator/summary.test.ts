import { describe, expect, it } from "vitest";
import { APP_MAP_APPS_SHOWN, builtAppLines } from "./summary.js";

const app = (name: string, modifiedMs: number) => ({ name, path: `workspace/apps/${name}`, files: ["index.html"], modifiedMs });

describe("the App Map's built apps", () => {
  it("stays the same size however many apps there are: the newest are named, the rest counted", () => {
    const [line] = builtAppLines(Array.from({ length: 141 }, (_, k) => app(`app-${k}`, k)));
    expect(line.startsWith("- Most recently changed: app-140, app-139,")).toBe(true);
    expect(line).toContain(`app-${141 - APP_MAP_APPS_SHOWN};`);
    expect(line).not.toContain(`app-${140 - APP_MAP_APPS_SHOWN},`);
    expect(line).toContain(`and ${141 - APP_MAP_APPS_SHOWN} more. \`app_list\` lists every app`);
    const many = builtAppLines(Array.from({ length: 1000 }, (_, k) => app(`a-much-longer-app-name-${k}`, k))).join("\n");
    expect(many.length).toBeLessThan(500);
  });

  it("names every app when they fit, newest first, and says when there are none", () => {
    expect(builtAppLines([app("calendar", 1), app("notes", 2)])).toEqual(["- notes, calendar"]);
    expect(builtAppLines([])).toEqual(["- No apps built yet"]);
  });
});
