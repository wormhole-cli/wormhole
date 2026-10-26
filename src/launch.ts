import { spawn } from 'node:child_process';

/** Run the target CLI in the foreground with the user's terminal; resolves to its exit code. */
export function launch(argv: string[], cwd: string): Promise<number> {
  const [bin, ...args] = argv;
  if (!bin) return Promise.resolve(1);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'ENOENT' ? new Error(`${bin} is not on PATH`) : err),
    );
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Shell-ready rendering of argv for printing. */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Hand a link to the OS, which opens the app registered for its scheme. */
export function openUrl(url: string): Promise<number> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  return launch([opener, url], process.cwd());
}
