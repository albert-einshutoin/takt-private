import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalConfigDir, getProjectConfigDir } from '../paths.js';
import { getLanguageResourcesDir } from '../../resources/index.js';
import type { FacetResolutionContext } from './workflowPackageScope.js';
import { getPackageFromWorkflowDir, getWorkflowBaseDir } from './workflowPackageScope.js';

const PARTIAL_DIR_SEGMENTS = ['partials', 'instructions'] as const;
const PARTIAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXPLICIT_PARTIAL_PATTERN = /\{partial:([^}]+)\}/g;
const BARE_PARTIAL_PATTERN = /\{([A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9._-]*)\}/g;

export interface ResolvedInstructionPartial {
  name: string;
  content: string;
  sourcePath: string;
}

function assertValidPartialName(name: string): void {
  if (!PARTIAL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid instruction partial name "${name}". Use a bare name without path separators.`);
  }
}

function formatCycle(frames: readonly string[], name: string): string {
  return [...frames, name].join(' -> ');
}

function partialDir(root: string): string {
  return join(root, ...PARTIAL_DIR_SEGMENTS);
}

function buildInstructionPartialCandidateDirs(context: FacetResolutionContext): string[] {
  const dirs: string[] = [];

  if (context.workflowDir && context.repertoireDir) {
    const workflowBaseDir = getWorkflowBaseDir(context.workflowDir);
    const pkg = getPackageFromWorkflowDir(workflowBaseDir, context.repertoireDir);
    if (pkg) {
      dirs.push(partialDir(join(context.repertoireDir, `@${pkg.owner}`, pkg.repo, 'facets')));
    }
  }

  if (context.projectDir) {
    dirs.push(partialDir(join(getProjectConfigDir(context.projectDir), 'facets')));
  }

  dirs.push(partialDir(join(getGlobalConfigDir(), 'facets')));
  dirs.push(partialDir(join(getLanguageResourcesDir(context.lang), 'facets')));
  return dirs;
}

export function resolveInstructionPartialByName(
  name: string,
  context: FacetResolutionContext,
): ResolvedInstructionPartial | undefined {
  assertValidPartialName(name);

  for (const dir of buildInstructionPartialCandidateDirs(context)) {
    const sourcePath = join(dir, `${name}.md`);
    if (existsSync(sourcePath)) {
      return {
        name,
        sourcePath,
        content: readFileSync(sourcePath, 'utf-8'),
      };
    }
  }

  return undefined;
}

function expandResolvedPartial(
  name: string,
  context: FacetResolutionContext,
  frames: readonly string[],
): string {
  assertValidPartialName(name);
  if (frames.includes(name)) {
    throw new Error(`Instruction partial cycle detected: ${formatCycle(frames, name)}`);
  }

  const partial = resolveInstructionPartialByName(name, context);
  if (!partial) {
    throw new Error(`Instruction partial "${name}" not found`);
  }

  return expandInstructionPartials(partial.content, context, [...frames, name]);
}

export function expandInstructionPartials(
  content: string,
  context: FacetResolutionContext | undefined,
  frames: readonly string[] = [],
): string {
  if (!content.includes('{')) {
    return content;
  }

  let expanded = content.replace(EXPLICIT_PARTIAL_PATTERN, (_match, rawName: string) => {
    const name = rawName.trim();
    if (!context) {
      throw new Error(`Instruction partial "${name}" cannot be resolved without a facet resolution context`);
    }
    return expandResolvedPartial(name, context, frames);
  });

  if (!context) {
    return expanded;
  }

  // Bare `{review-common}` references are intentionally best-effort so existing
  // instructional placeholders like `{report-name}` remain valid unless a real
  // partial file exists in the active layer set.
  expanded = expanded.replace(BARE_PARTIAL_PATTERN, (match, name: string) => {
    assertValidPartialName(name);
    const partial = resolveInstructionPartialByName(name, context);
    if (!partial) {
      return match;
    }
    if (frames.includes(name)) {
      throw new Error(`Instruction partial cycle detected: ${formatCycle(frames, name)}`);
    }
    return expandInstructionPartials(partial.content, context, [...frames, name]);
  });

  return expanded;
}
