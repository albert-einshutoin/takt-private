/**
 * Project-local files written by TAKT itself. Keeping these names together
 * prevents export/backup code from drifting away from the producing runtime.
 */
export const PROJECT_TAKT_DIRECTORY = '.takt';
export const PROJECT_TASKS_FILE = 'tasks.yaml';
export const PROJECT_STAGED_DEVLOOP_STATE_FILE = 'staged-devloop-state.json';
export const PROJECT_CLONE_META_DIRECTORY = 'clone-meta';
export const PROJECT_FINDINGS_DIRECTORY = 'findings';
export const PROJECT_WORKTREE_SESSIONS_DIRECTORY = 'worktree-sessions';
export const PROJECT_INPUT_HISTORY_FILE = 'input_history';
export const PROJECT_PERSONA_SESSIONS_FILE = 'persona_sessions.json';
export const PROJECT_SESSION_STATE_FILE = 'session-state.json';

export const PROJECT_RUNTIME_DIRECTORY_NAMES = [
  '.runtime',
  'cache',
  PROJECT_CLONE_META_DIRECTORY,
  'completed',
  PROJECT_FINDINGS_DIRECTORY,
  'language-cache',
  'logs',
  'persona',
  'runs',
  'session',
  'sessions',
  'staged',
  'tasks',
  'tmp',
  'worktrees',
  PROJECT_WORKTREE_SESSIONS_DIRECTORY,
] as const;

export const PROJECT_RUNTIME_FILE_NAMES = [
  PROJECT_INPUT_HISTORY_FILE,
  PROJECT_PERSONA_SESSIONS_FILE,
  PROJECT_SESSION_STATE_FILE,
  PROJECT_TASKS_FILE,
  PROJECT_STAGED_DEVLOOP_STATE_FILE,
] as const;
