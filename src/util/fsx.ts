import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function readJsonSafe<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    return await readJson<T>(file);
  } catch {
    return null;
  }
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'a' });
}

export async function writeText(file: string, value: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, value, 'utf8');
}

export async function listFilesRecursive(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out.sort();
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function projectRoot(): string {
  const here = import.meta.dirname;
  return path.resolve(here, '..', '..');
}
