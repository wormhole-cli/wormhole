import { promises as fs } from 'node:fs';
import { capture } from '../proc.js';

/**
 * Read complete JSONL lines starting at a byte offset. A trailing partial line
 * (a writer mid-append) is left for the next read.
 */
export async function readJsonlFrom(file: string, fromOffset = 0): Promise<{ records: unknown[]; offset: number; positions: number[] }> {
  const buf = await fs.readFile(file);
  const end = buf.lastIndexOf(0x0a) + 1;
  if (end <= fromOffset) return { records: [], offset: fromOffset, positions: [] };
  const records: unknown[] = [];
  const positions: number[] = [];
  let position = fromOffset;
  for (const line of buf.subarray(fromOffset, end).toString('utf8').split('\n')) {
    const start = position;
    position += Buffer.byteLength(line, 'utf8') + 1;
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
      positions.push(start);
    } catch {
      // Skip corrupt lines rather than failing the whole import.
    }
  }
  return { records, offset: end, positions };
}

/** `env K=V …` ahead of a command, so a printed or launched command carries an account's folder. */
export function envPrefix(env: Record<string, string> | undefined): string[] {
  const pairs = Object.entries(env ?? {});
  return pairs.length > 0 ? ['env', ...pairs.map(([k, v]) => `${k}=${v}`)] : [];
}

export function toJsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** First token of `<bin> --version`, or the fallback when the binary is missing. */
export async function cliVersion(bin: string, fallback: string): Promise<string> {
  const r = await capture(bin, ['--version']);
  if (!r || r.code !== 0) return fallback;
  return r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? fallback;
}

/** Newest file by mtime among the given paths. */
export async function newestByMtime(files: string[]): Promise<{ file: string; mtime: Date } | null> {
  let best: { file: string; mtime: Date } | null = null;
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && (!best || stat.mtime > best.mtime)) best = { file, mtime: stat.mtime };
  }
  return best;
}
