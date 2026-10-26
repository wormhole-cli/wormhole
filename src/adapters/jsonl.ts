import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

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

export function toJsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** First token of `<bin> --version`, or the fallback when the binary is missing. */
export async function cliVersion(bin: string, fallback: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 10_000 });
    const match = stdout.match(/\d+\.\d+\.\d+[\w.-]*/);
    return match?.[0] ?? fallback;
  } catch {
    return fallback;
  }
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
