import { Stats, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { InternalWorkflowReadContext } from './workflowDiscovery.js';
import { WorkflowDiscoveryReadError } from './workflowDiscoveryError.js';
import type { RepertoireResourceReadAccess } from './workflowPackageScope.js';
import type { FacetResolutionContext } from './workflowPackageScope.js';
import { readApprovedRepertoireWorkflowText } from './workflowRepertoireSafeReader.js';
import { getRepertoireDir } from '../paths.js';

const safeObjectFreeze = Object.freeze.bind(Object);
const safeReflectApply = Reflect.apply.bind(Reflect);
const safeStatsIsSymbolicLinkMethod = Stats.prototype.isSymbolicLink;
const safeWeakSetAddMethod = WeakSet.prototype.add;
const safeWeakSetHasMethod = WeakSet.prototype.has;
const trustedAccesses = new WeakSet<RepertoireResourceReadAccess>();

/** @internal Binds all repertoire resource I/O to one already-active workflow read lease. */
export function createRepertoireResourceReadAccess(
  context: InternalWorkflowReadContext,
): RepertoireResourceReadAccess {
  const assertRead = () => context.assertRead();
  const relativePath = (path: string): string => {
    const candidate = relative(context.repertoireDir, path);
    if (candidate.startsWith('..') || isAbsolute(candidate)) throw failed();
    return candidate;
  };
  const expectedRealPath = (path: string): string => join(context.repertoireRealPath, relativePath(path));

  const access = safeObjectFreeze({
    contains: (path: string) => {
      const candidate = relative(context.repertoireDir, path);
      return !candidate.startsWith('..') && !isAbsolute(candidate);
    },
    exists: (path: string) => {
      expectedRealPath(path);
      assertRead();
      try {
        const stat = lstatSync(path);
        if (safeReflectApply(safeStatsIsSymbolicLinkMethod, stat, []) as boolean) throw failed();
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        if (error instanceof WorkflowDiscoveryReadError) throw error;
        throw failed();
      }
    },
    isSymlink: (path: string) => {
      expectedRealPath(path);
      assertRead();
      try {
        return safeReflectApply(safeStatsIsSymbolicLinkMethod, lstatSync(path), []) as boolean;
      } catch {
        throw failed();
      }
    },
    readText: (path: string) => readApprovedRepertoireWorkflowText({
      assertRead,
      expectedRealPath: expectedRealPath(path),
      path,
      repertoireDir: context.repertoireDir,
    }),
    realpath: (path: string) => {
      const expected = expectedRealPath(path);
      assertRead();
      try {
        const actual = realpathSync(path);
        if (actual !== expected) throw failed();
        return actual;
      } catch (error) {
        if (error instanceof WorkflowDiscoveryReadError) throw error;
        throw failed();
      }
    },
  });
  safeReflectApply(safeWeakSetAddMethod, trustedAccesses, [access]);
  return access;
}

/** Selects the lease-bound adapter only when a candidate actually enters repertoire. */
export function resourceExists(path: string, context?: FacetResolutionContext): boolean {
  const access = getRequiredRepertoireAccess(path, context);
  return access ? access.exists(path) : lstatExists(path);
}

export function readResourceText(path: string, context?: FacetResolutionContext): string {
  const access = getRequiredRepertoireAccess(path, context);
  return access ? access.readText(path) : readNodeText(path);
}

export function resourceRealpath(path: string, context?: FacetResolutionContext): string {
  const access = getRequiredRepertoireAccess(path, context);
  return access ? access.realpath(path) : realpathSync(path);
}

export function resourceIsSymlink(path: string, context?: FacetResolutionContext): boolean {
  const access = getRequiredRepertoireAccess(path, context);
  return access ? access.isSymlink(path) : lstatSync(path).isSymbolicLink();
}

/**
 * Classifies a candidate without trusting its lexical spelling. An alias whose
 * canonical target enters the coordinated repertoire is rejected; callers can
 * retry under a permit, but aliases remain outside the root-bound authority.
 */
export function isRepertoireResourcePath(path: string, context?: FacetResolutionContext): boolean {
  if (!context?.repertoireDir) return false;
  const repertoireDir = resolve(context.repertoireDir);
  const candidatePath = resolve(path);
  if (isInsideOrEqual(repertoireDir, candidatePath)) return true;
  if (
    repertoireDir !== resolve(getRepertoireDir())
    || !existsSync(repertoireDir)
    || !existsSync(path)
  ) return false;
  let canonicalPath: string;
  let canonicalRepertoireDir: string;
  try {
    canonicalPath = realpathSync(path);
    canonicalRepertoireDir = realpathSync(repertoireDir);
  } catch {
    throw failed();
  }
  if (isInsideOrEqual(canonicalRepertoireDir, canonicalPath)) throw failed();
  return false;
}

/** True only for the process-owned root or a capability minted by this module. */
export function hasCoordinatedRepertoireContext(context?: FacetResolutionContext): boolean {
  if (!context?.repertoireDir) return false;
  if (resolve(context.repertoireDir) === resolve(getRepertoireDir())) return true;
  const access = context.repertoireReadAccess;
  return access !== undefined
    && (safeReflectApply(safeWeakSetHasMethod, trustedAccesses, [access]) as boolean);
}

function getRequiredRepertoireAccess(
  path: string,
  context?: FacetResolutionContext,
): RepertoireResourceReadAccess | undefined {
  if (!isRepertoireResourcePath(path, context)) return undefined;
  if (!context?.repertoireDir) return undefined;
  const access = context.repertoireReadAccess;
  if (
    access === undefined
    || !(safeReflectApply(safeWeakSetHasMethod, trustedAccesses, [access]) as boolean)
    || !access.contains(path)
  ) {
    // Custom roots are supported by pure resolver tests and embedding hosts. The
    // process-owned repertoire root is the only root governed by coordination.
    if (resolve(context.repertoireDir) === resolve(getRepertoireDir())) throw failed();
    return undefined;
  }
  return access;
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function lstatExists(path: string): boolean {
  return existsSync(path);
}

function readNodeText(path: string): string {
  return readFileSync(path, 'utf-8');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT';
}

function failed(): WorkflowDiscoveryReadError {
  return new WorkflowDiscoveryReadError();
}
