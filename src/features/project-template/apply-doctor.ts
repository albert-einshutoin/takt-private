import {
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadProjectConfig } from '../../infra/config/project/projectConfig.js';
import { invalidateResolvedConfigCache } from '../../infra/config/resolutionCache.js';
import { inspectWorkflowFile } from '../../infra/config/loaders/workflowDoctor.js';

const MAX_WORKFLOW_TREE_ENTRIES = 4_096;
const MAX_DIAGNOSTICS_PER_CHECK = 100;
const MAX_DIAGNOSTIC_CHARS = 1_024;

export type ProjectTemplateDoctorCheckKind =
  | 'config'
  | 'workflow'
  | 'workflow-tree';

export interface ProjectTemplateDoctorCheck {
  kind: ProjectTemplateDoctorCheckKind;
  path: string;
  passed: boolean;
  diagnostics: string[];
}

export interface ProjectTemplateDoctorReport {
  passed: boolean;
  checks: ProjectTemplateDoctorCheck[];
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function sanitizeDiagnostic(message: string, projectRoot: string): string {
  return message
    .split(resolve(projectRoot)).join('<project>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

function collectWorkflowFiles(projectRoot: string): string[] {
  const workflowRoot = join(projectRoot, '.takt', 'workflows');
  if (!existsSync(workflowRoot)) return [];
  const rootStat = lstatSync(workflowRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('unsafe workflow root');
  }
  const files: string[] = [];
  const pending = [workflowRoot];
  let inspectedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_WORKFLOW_TREE_ENTRIES || entry.isSymbolicLink()) {
        throw new Error('unsafe workflow tree');
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (
        entry.isFile()
        && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))
      ) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
          throw new Error('unsafe workflow file');
        }
        files.push(path);
      } else if (!entry.isFile()) {
        throw new Error('unsafe workflow entry');
      }
    }
  }
  return files.sort();
}

/**
 * Runs only local, read-only validators after a template transaction. Network,
 * authentication, and external commands are intentionally outside this
 * boundary so rollback does not depend on ambient services.
 */
export function runProjectTemplateDoctor(
  projectRootValue: string,
): ProjectTemplateDoctorReport {
  const projectRoot = resolve(projectRootValue);
  let workflowFiles: string[];
  try {
    workflowFiles = collectWorkflowFiles(projectRoot);
  } catch {
    return {
      passed: false,
      checks: [{
        kind: 'workflow-tree',
        path: 'workflows',
        passed: false,
        diagnostics: ['unsafe or unreadable workflow tree'],
      }],
    };
  }

  const checks: ProjectTemplateDoctorCheck[] = [];
  invalidateResolvedConfigCache(projectRoot);
  try {
    loadProjectConfig(projectRoot);
    checks.push({
      kind: 'config',
      path: 'config.yaml',
      passed: true,
      diagnostics: [],
    });
  } catch (error) {
    checks.push({
      kind: 'config',
      path: 'config.yaml',
      passed: false,
      diagnostics: [
        sanitizeDiagnostic(
          error instanceof Error ? error.message : 'project config validation failed',
          projectRoot,
        ),
      ],
    });
  } finally {
    invalidateResolvedConfigCache(projectRoot);
  }

  for (const filePath of workflowFiles) {
    const report = inspectWorkflowFile(filePath, projectRoot, {
      lookupCwd: projectRoot,
      source: 'project',
    });
    const diagnostics = report.diagnostics
      .slice(0, MAX_DIAGNOSTICS_PER_CHECK)
      .map((item) => sanitizeDiagnostic(item.message, projectRoot));
    checks.push({
      kind: 'workflow',
      path: portableRelative(join(projectRoot, '.takt'), filePath),
      passed: !report.diagnostics.some((item) => item.level === 'error'),
      diagnostics,
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}
