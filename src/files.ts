import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function jsonlFiles(dir: string, name: RegExp): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && name.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
