import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const CHUNK_BYTES = 1 << 20;

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export async function eachLine(
  text: AsyncIterable<string>,
  visit: (line: string) => void,
): Promise<void> {
  let rest = "";
  for await (const chunk of text) {
    const end = chunk.lastIndexOf("\n");
    if (end === -1) {
      rest += chunk;
      continue;
    }
    const head = chunk.slice(0, end);
    for (const line of (rest === "" ? head : rest + head).split("\n")) visit(line);
    rest = chunk.slice(end + 1);
  }
  if (rest !== "") visit(rest);
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
