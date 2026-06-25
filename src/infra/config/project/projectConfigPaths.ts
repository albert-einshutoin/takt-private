import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function getGlobalConfigDirForCollisionCheck(): string {
  return process.env.TAKT_CONFIG_DIR || join(homedir(), '.takt');
}

function normalizeConfigDir(configDir: string): string {
  return existsSync(configDir) ? realpathSync(configDir) : resolve(configDir);
}

export function getProjectConfigDir(projectDir: string): string {
  return join(resolve(projectDir), '.takt');
}

export function getProjectConfigPath(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'config.yaml');
}

export function isProjectConfigDirDisabled(projectDir: string): boolean {
  // Treat a path collision as global-only so global-only keys are never parsed with project validation.
  return normalizeConfigDir(getProjectConfigDir(projectDir)) === normalizeConfigDir(getGlobalConfigDirForCollisionCheck());
}
