import type { TaskListItem } from '../../../infra/task/index.js';
import { formatShortTimestampForDisplay, type TimestampFormatOptions } from '../../../shared/utils/timestamp.js';

const TASK_STATUS_BY_KIND: Record<TaskListItem['kind'], string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  exceeded: 'exceeded',
  pr_failed: 'pr-failed',
};

export function formatTaskStatusLabel(task: TaskListItem): string {
  let status = `[${TASK_STATUS_BY_KIND[task.kind]}] ${task.name}`;
  if (task.issueNumber !== undefined) {
    status += ` #${task.issueNumber}`;
  }
  if (task.branch) {
    return `${status} (${task.branch})`;
  }
  return status;
}

export function formatShortDate(isoString: string, options: TimestampFormatOptions = {}): string {
  return formatShortTimestampForDisplay(isoString, options);
}
