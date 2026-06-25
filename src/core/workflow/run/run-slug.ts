import * as fs from 'node:fs';

import { generateReportDir } from '../../../shared/utils/reportDir.js';
import type { TimestampFormatOptions } from '../../../shared/utils/timestamp.js';
import { buildRunPaths } from './run-paths.js';

function generateReportDirSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

export function generateExecutionReportDir(
  cwd: string,
  task: string,
  options: TimestampFormatOptions = {},
): string {
  const baseSlug = `${generateReportDir(task, options)}-${generateReportDirSuffix()}`;
  let sequence = 1;
  let slug = baseSlug;
  let runRootAbs = buildRunPaths(cwd, slug).runRootAbs;

  while (fs.existsSync(runRootAbs)) {
    sequence += 1;
    slug = `${baseSlug}-${sequence}`;
    runRootAbs = buildRunPaths(cwd, slug).runRootAbs;
  }

  return slug;
}
