import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { slugify } from '../../shared/utils/slug.js';

function createUniqueClonePath(baseDir: string, name: string): string {
  const resolvedBaseDir = path.resolve(baseDir);
  fs.mkdirSync(resolvedBaseDir, { recursive: true });
  // mkdtemp atomically reserves the path, avoiding both check-then-create races
  // and probabilistic collisions while retaining a readable operator prefix.
  return fs.mkdtempSync(path.join(resolvedBaseDir, `${name}-`));
}

function createUnreservedUniqueClonePath(baseDir: string, name: string): string {
  // PR sync hands the destination to git clone, which must own directory
  // creation. A cryptographic suffix removes the same-tick naming race without
  // pre-creating a directory that changes clone semantics.
  const suffix = randomBytes(8).toString('hex');
  return path.join(path.resolve(baseDir), `${name}-${suffix}`);
}

export function createTaskClonePath(
  baseDir: string,
  timestamp: string,
  issueNumber: number | undefined,
  taskSlug: string,
): string {
  // Task slugs can originate from external issue text, so normalize them before
  // joining paths to prevent separators or dot segments from escaping baseDir.
  const safeTaskSlug = slugify(taskSlug);
  const nameParts = [
    timestamp,
    safeTaskSlug && issueNumber !== undefined ? String(issueNumber) : undefined,
    safeTaskSlug,
  ];

  return createUniqueClonePath(baseDir, nameParts.filter(Boolean).join('-'));
}

export function createTempClonePath(baseDir: string, timestamp: string): string {
  return createUniqueClonePath(baseDir, `tmp-${timestamp}`);
}

export function createPrSyncWorktreePath(baseDir: string, timestamp: number): string {
  return createUnreservedUniqueClonePath(baseDir, `pr-sync-${timestamp}`);
}
