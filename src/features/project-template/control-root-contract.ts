export const PROJECT_TEMPLATE_CONTROL_DIRECTORY = '.takt-template-state';
export const PROJECT_TEMPLATE_CONTROL_GITIGNORE_TEXT = '*\n';

export function isProjectTemplateOwnerOnlyMode(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' || (mode & 0o077) === 0;
}

export function isProjectTemplatePrivateDirectoryMode(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' || (mode & 0o777) === 0o700;
}

export function isProjectTemplatePrivateFileMode(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' || (mode & 0o777) === 0o600;
}
