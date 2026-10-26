import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface GitInfo {
  branch: string;
  status: string[];
  diffStat: string;
  recentCommits: string[];
}

const STATUS_MAX = 40;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('git', args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trimEnd();
}

/** Working-tree snapshot for the brief, or null outside a git repo. */
export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return null;
  }
  const [branch, status, diffStat, log] = await Promise.all([
    git(cwd, ['branch', '--show-current']).catch(() => ''),
    git(cwd, ['status', '--porcelain']).catch(() => ''),
    git(cwd, ['diff', 'HEAD', '--stat']).catch(() => ''),
    git(cwd, ['log', '--oneline', '-5']).catch(() => ''),
  ]);
  const statusLines = status ? status.split('\n') : [];
  return {
    branch,
    status:
      statusLines.length > STATUS_MAX
        ? [...statusLines.slice(0, STATUS_MAX), `… ${statusLines.length - STATUS_MAX} more`]
        : statusLines,
    diffStat,
    recentCommits: log ? log.split('\n') : [],
  };
}
