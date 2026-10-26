import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';

/**
 * `child_process.spawn` that also runs Windows `.cmd` / `.bat` shims, which is how npm installs
 * `claude`, `codex` and `opencode` there, with arguments quoted safely for cmd.exe.
 */
export const spawnProgram = crossSpawn;

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a program to completion with no stdin, capturing its output; null when it cannot be started. */
export function capture(
  bin: string,
  args: string[],
  { cwd, env, timeoutMs = 10_000 }: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Captured | null> {
  return new Promise((resolve) => {
    const child = spawnProgram(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr, timedOut });
    });
  });
}

/**
 * Absolute path of `bin` on PATH, or null. On Windows a name matches with any PATHEXT extension
 * (`claude` finds `claude.cmd`); elsewhere the file has to be executable.
 */
export async function findOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const windows = platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean);
  const exts = windows
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, bin + ext);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) continue;
      if (windows ? ext !== '' || path.extname(bin) !== '' : await isExecutable(file)) return file;
    }
  }
  return null;
}

function isExecutable(file: string): Promise<boolean> {
  return fs.access(file, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}
