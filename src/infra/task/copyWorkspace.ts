import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../shared/utils/index.js';

const log = createLogger('copy-workspace');

const EXCLUDED_TOP_LEVEL_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);

const EXCLUDED_TAKT_CHILDREN = new Set([
  'runs',
  'worktrees',
]);

export interface CopyWorkspaceOptions {
  taskSlug: string;
}

export interface CopyWorkspaceResult {
  path: string;
}

function generateTimestamp(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 13);
}

function resolveCopyWorkspaceBaseDir(projectDir: string): string {
  return path.join(projectDir, '..', 'takt-workspaces');
}

function reserveCopyWorkspacePath(baseDir: string, taskSlug: string): string {
  fs.mkdirSync(baseDir, { recursive: true });
  const timestamp = generateTimestamp();
  return fs.mkdtempSync(path.join(baseDir, `${timestamp}-${taskSlug}-`));
}

function shouldCopyPath(projectDir: string, sourcePath: string): boolean {
  const relative = path.relative(projectDir, sourcePath);
  if (!relative) {
    return true;
  }

  const parts = relative.split(path.sep);
  const topLevel = parts[0];
  if (!topLevel) {
    return true;
  }

  if (EXCLUDED_TOP_LEVEL_NAMES.has(topLevel)) {
    return false;
  }

  if (topLevel === '.takt' && parts[1] && EXCLUDED_TAKT_CHILDREN.has(parts[1])) {
    return false;
  }

  return true;
}

export function createCopyWorkspace(projectDir: string, options: CopyWorkspaceOptions): CopyWorkspaceResult {
  const baseDir = resolveCopyWorkspaceBaseDir(projectDir);
  const workspacePath = reserveCopyWorkspacePath(baseDir, options.taskSlug);
  log.info('Creating copy workspace', { projectDir, workspacePath });

  try {
    fs.cpSync(projectDir, workspacePath, {
      recursive: true,
      errorOnExist: false,
      force: true,
      verbatimSymlinks: true,
      filter: (sourcePath) => shouldCopyPath(projectDir, sourcePath),
    });
  } catch (error) {
    fs.rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    throw error;
  }

  log.info('Copy workspace created', { workspacePath });
  return { path: workspacePath };
}

export async function createCopyWorkspaceAbortable(
  projectDir: string,
  options: CopyWorkspaceOptions,
  abortSignal?: AbortSignal,
): Promise<CopyWorkspaceResult> {
  if (abortSignal?.aborted) {
    throw new Error('Copy workspace creation aborted');
  }
  // The copy itself is synchronous so filesystem state is either a complete copy
  // or removed by createCopyWorkspace on failure; callers still get a Promise to
  // match the abortable shared-clone API used in the same execution resolver.
  return createCopyWorkspace(projectDir, options);
}
