/**
 * A brand's colors and fonts read from what the user already has: the theme
 * inside an Office template, and the inks of a logo.
 */
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { suggestFromFile, suggestFromImage, suggestFromOfficeFile } from "./brand-import.js";

const THEME = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="NutriShop">
<a:themeElements><a:clrScheme name="NutriShop">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1B1B3A"/></a:dk2><a:lt2><a:srgbClr val="F4F4F0"/></a:lt2>
<a:accent1><a:srgbClr val="7F7F7F"/></a:accent1><a:accent2><a:srgbClr val="E4572E"/></a:accent2><a:accent3><a:srgbClr val="B5D334"/></a:accent3>
<a:accent4><a:srgbClr val="29335C"/></a:accent4><a:accent5><a:srgbClr val="F3A712"/></a:accent5><a:accent6><a:srgbClr val="A8C686"/></a:accent6>
</a:clrScheme><a:fontScheme name="x"><a:majorFont><a:latin typeface="Montserrat"/></a:majorFont><a:minorFont><a:latin typeface="Open Sans"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`;

async function officeFile(part: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(part, THEME);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("brand import", () => {
  it("reads a PowerPoint template's theme colors and fonts, skipping the grey accent", async () => {
    const s = await suggestFromOfficeFile(await officeFile("ppt/theme/theme1.xml"), "NutriShop.potx");
    expect(s.colors).toEqual({ primary: "E4572E", secondary: "B5D334", dark: "1B1B3A", light: "F4F4F0" });
    expect(s.fonts).toEqual({ heading: "Montserrat", body: "Open Sans" });
    expect(s.found).toContain("29335C");
  });

  it("reads a Word template the same way", async () => {
    const s = await suggestFromFile(await officeFile("word/theme/theme1.xml"), "Letter.dotx");
    expect(s.colors.primary).toBe("E4572E");
  });

  it("says so when a file has no theme, or is not an Office file", async () => {
    const empty = await new JSZip().generateAsync({ type: "nodebuffer" });
    await expect(suggestFromOfficeFile(empty, "x.pptx")).rejects.toThrow(/no theme/);
    await expect(suggestFromOfficeFile(empty, "x.pdf")).rejects.toThrow(/not a PowerPoint/);
  });

  it("finds a logo's inks, most area first, leaving out its white background", async () => {
    const logo = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#FFFFFF" } })
      .composite([
        { input: await sharp({ create: { width: 60, height: 50, channels: 3, background: "#E4572E" } }).png().toBuffer(), left: 0, top: 0 },
        { input: await sharp({ create: { width: 20, height: 50, channels: 3, background: "#1F5A3A" } }).png().toBuffer(), left: 70, top: 0 },
      ]).png().toBuffer();
    const s = await suggestFromImage(logo, "logo.png");
    expect(s.colors.primary).toBe("E4572E");
    expect(s.colors.secondary).toBe("1F5A3A");
    expect(s.found).not.toContain("FFFFFF");
  });
});
