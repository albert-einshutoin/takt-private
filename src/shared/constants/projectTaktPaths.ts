/**
 * Project-local files written by TAKT itself. Keeping these names together
 * prevents export/backup code from drifting away from the producing runtime.
 */
export const PROJECT_TAKT_DIRECTORY = '.takt';
export const PROJECT_TASKS_FILE = 'tasks.yaml';
export const PROJECT_STAGED_DEVLOOP_STATE_FILE = 'staged-devloop-state.json';

export const PROJECT_RUNTIME_DIRECTORY_NAMES = [
  '.runtime',
  'cache',
  'completed',
  'language-cache',
  'logs',
  'persona',
  'personas',
  'runs',
  'session',
  'sessions',
  'staged',
  'tasks',
  'tmp',
  'worktrees',
] as const;

export const PROJECT_RUNTIME_FILE_NAMES = [
  PROJECT_TASKS_FILE,
  PROJECT_STAGED_DEVLOOP_STATE_FILE,
] as const;
