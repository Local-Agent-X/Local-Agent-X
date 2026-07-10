import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;

interface ZipEntryData {
  compressedSize?: number;
  uncompressedSize?: number;
}

export interface ZipInspection {
  macroEnabled: boolean;
  entryCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
}

function unsafeEntryName(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return /[\x00-\x1f]/.test(normalized) || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").some((part) => part === "..");
}

function zipError(error: unknown): Error {
  const message = (error as Error).message || String(error);
  if (/encrypt/i.test(message)) return new Error("Encrypted archives are not allowed.");
  return new Error(`Malformed ZIP archive: ${message}`);
}

const OOXML: Record<string, { root: string; main: string; contentType: string }> = {
  ".docx": {
    root: "word/", main: "word/document.xml",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  },
  ".xlsx": {
    root: "xl/", main: "xl/workbook.xml",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  },
  ".pptx": {
    root: "ppt/", main: "ppt/presentation.xml",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  },
  ".docm": {
    root: "word/", main: "word/document.xml",
    contentType: "application/vnd.ms-word.document.macroEnabled.main+xml",
  },
  ".xlsm": {
    root: "xl/", main: "xl/workbook.xml",
    contentType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  },
  ".xlam": {
    root: "xl/", main: "xl/workbook.xml",
    contentType: "application/vnd.ms-excel.addin.macroEnabled.main+xml",
  },
  ".pptm": {
    root: "ppt/", main: "ppt/presentation.xml",
    contentType: "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  },
};

export async function inspectZipFile(path: string, filename: string): Promise<ZipInspection> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(path), { createFolders: false });
  } catch (error) {
    throw zipError(error);
  }

  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP archive has too many entries (${entries.length}).`);
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let macroEnabled = false;
  const names = new Set<string>();

  for (const entry of entries) {
    const original = entry.unsafeOriginalName ?? entry.name;
    if (unsafeEntryName(original) || unsafeEntryName(entry.name)) throw new Error(`ZIP path traversal entry rejected: ${original}`);
    const name = entry.name.replace(/\\/g, "/");
    if (typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0o170000) === 0o120000) {
      throw new Error(`ZIP symbolic-link entry rejected: ${name}`);
    }
    names.add(name);
    if (/vbaProject\.bin$|(^|\/)macros\//i.test(name)) macroEnabled = true;
    if (entry.dir) continue;
    const data = (entry as unknown as { _data?: ZipEntryData })._data;
    const compressed = data?.compressedSize;
    const uncompressed = data?.uncompressedSize;
    if (!Number.isSafeInteger(compressed) || !Number.isSafeInteger(uncompressed) || compressed! < 0 || uncompressed! < 0) {
      throw new Error(`ZIP entry has invalid central-directory sizes: ${name}`);
    }
    if (uncompressed! > MAX_ENTRY_UNCOMPRESSED) throw new Error(`ZIP entry is too large when expanded: ${name}`);
    compressedBytes += compressed!;
    uncompressedBytes += uncompressed!;
    if (uncompressedBytes > MAX_TOTAL_UNCOMPRESSED) throw new Error("ZIP archive expands beyond the allowed size.");
  }

  if (uncompressedBytes > 10 * 1024 * 1024 && uncompressedBytes > Math.max(1, compressedBytes) * MAX_EXPANSION_RATIO) {
    throw new Error("ZIP archive expansion ratio is unsafe (possible zip bomb).");
  }

  const spec = OOXML[extname(filename).toLowerCase()];
  if (spec) {
    const contentTypes = zip.file("[Content_Types].xml");
    const contentData = contentTypes && (contentTypes as unknown as { _data?: ZipEntryData })._data;
    if (!contentTypes || !contentData || (contentData.uncompressedSize ?? Infinity) > MAX_CONTENT_TYPES_BYTES) {
      throw new Error("OOXML package is missing a valid [Content_Types].xml.");
    }
    if (!names.has(spec.main) || ![...names].some((name) => name.startsWith(spec.root) && name !== spec.root)) {
      throw new Error(`OOXML package is missing required ${spec.root} structure.`);
    }
    const xml = await contentTypes.async("string");
    const override = (xml.match(/<Override\b[^>]*>/gi) ?? []).some((tag) => {
      const part = tag.match(/\bPartName\s*=\s*["']([^"']+)["']/i)?.[1];
      const type = tag.match(/\bContentType\s*=\s*["']([^"']+)["']/i)?.[1];
      return part === `/${spec.main}` && type === spec.contentType;
    });
    if (!override) {
      throw new Error("OOXML [Content_Types].xml does not declare the expected main document part.");
    }
  }

  return { macroEnabled, entryCount: entries.length, compressedBytes, uncompressedBytes };
}
