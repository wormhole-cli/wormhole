import { spawnProgram } from './proc.js';

/**
 * Run the target CLI in the foreground with the user's terminal; resolves to its exit code.
 * A leading `env K=V …` (how account launches are written) sets those variables here, so it
 * works on Windows too, where there is no `env` program.
 */
export function launch(argv: string[], cwd: string): Promise<number> {
  const { env, command } = splitEnv(argv);
  const [bin, ...args] = command;
  if (!bin) return Promise.resolve(1);
  return new Promise((resolve, reject) => {
    const child = spawnProgram(bin, args, {
      cwd,
      stdio: 'inherit',
      ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'ENOENT' ? new Error(`${bin} is not on PATH`) : err),
    );
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** `env A=1 B=2 cmd args` → the variables and the command. */
export function splitEnv(argv: string[]): { env: Record<string, string>; command: string[] } {
  if (argv[0] !== 'env') return { env: {}, command: argv };
  const env: Record<string, string> = {};
  let i = 1;
  for (; i < argv.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(argv[i]!);
    if (!m) break;
    env[m[1]!] = m[2]!;
  }
  return { env, command: argv.slice(i) };
}

/** argv as a line to paste into the user's shell: POSIX sh, or PowerShell on Windows. */
export function shellLine(argv: string[], platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
  }
  const { env, command } = splitEnv(argv);
  const quote = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, "''")}'`);
  const sets = Object.entries(env).map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}'; `);
  return sets.join('') + command.map(quote).join(' ');
}

/** Hand a link to the OS, which opens the app registered for its scheme. */
export function openUrl(url: string, run: typeof launch = launch, platform = process.platform): Promise<number> {
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  return run([opener, url], process.cwd());
}
