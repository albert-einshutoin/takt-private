/**
 * Report directory name generation.
 */

import { slugify } from './slug.js';
import { formatTimestampForFilename, type TimestampFormatOptions } from './timestamp.js';

export function generateReportDir(task: string, options: TimestampFormatOptions = {}): string {
  const timestamp = formatTimestampForFilename(new Date(), options);

  const summary = slugify(task.slice(0, 80)) || 'task';

  return `${timestamp}-${summary}`;
}
