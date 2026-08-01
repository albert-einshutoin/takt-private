import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const { childEnvironment, mockExecFileSync, mockConfirm } = vi.hoisted(() => ({
  childEnvironment: {
    active: process.env['TAKT_REPERTOIRE_MUTATION_CHILD'] === '1',
    action: process.env['TAKT_REPERTOIRE_MUTATION_ACTION'],
    root: process.env['TAKT_REPERTOIRE_MUTATION_ROOT'],
    readyPath: process.env['TAKT_REPERTOIRE_MUTATION_READY_PATH'],
  },
  mockExecFileSync: vi.fn(),
  mockConfirm: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFileSync: mockExecFileSync }));

vi.mock('../../features/repertoire/github-ref-resolver.js', () => ({
  resolveRef: vi.fn(() => 'main'),
}));

vi.mock('../../infra/config/paths.js', () => ({
  getBuiltinProviderOptionsDir: (lang: string) => join(requiredRoot(), 'builtins', lang, 'provider-options'),
  getGlobalConfigDir: () => requiredRoot(),
  getGlobalProviderOptionsDir: () => join(requiredRoot(), 'provider-options'),
  getGlobalWorkflowsDir: () => join(requiredRoot(), 'workflows'),
  getProjectProviderOptionsDir: () => join(requiredRoot(), 'project', '.takt', 'provider-options'),
  getProjectWorkflowsDir: () => join(requiredRoot(), 'project', '.takt', 'workflows'),
  getRepertoireDir: () => join(requiredRoot(), 'repertoire'),
  getRepertoirePackageDir: (owner: string, repo: string) => (
    join(requiredRoot(), 'repertoire', `@${owner}`, repo)
  ),
}));

vi.mock('../../infra/config/global/index.js', () => ({
  getWorkflowCategoriesPath: () => join(requiredRoot(), 'preferences', 'workflow-categories.yaml'),
}));

vi.mock('../../infra/config/resolveWorkflowConfigValue.js', () => ({
  resolveWorkflowConfigValues: vi.fn(() => ({ language: 'ja' })),
}));

vi.mock('../../shared/prompt/index.js', () => ({ confirm: mockConfirm }));
vi.mock('../../shared/ui/index.js', () => ({ info: vi.fn(), success: vi.fn() }));

it('runs one real add or remove command behind the filesystem lease', async () => {
  if (!childEnvironment.active) {
    expect(childEnvironment.active).toBe(false);
    return;
  }

  const readyPath = requiredEnvironment('readyPath');
  mockConfirm.mockResolvedValue(true);
  const mutationOptions = {
    timeoutMs: 10_000,
    onLeaseAttempted: () => {
      writeFileSync(readyPath, 'attempted\n', { mode: 0o600, flag: 'wx' });
    },
  };
  mockExecFileSync.mockImplementation((command: string, args: string[]) => {
    if (command === 'gh' && args[0] === '--version') return Buffer.from('gh version 2.0.0');
    if (command === 'gh' && args[0] === 'api') return Buffer.from('tarball');
    if (command === 'tar' && args[0] === 'tvzf') return tarListing();
    if (command === 'tar' && args[0] === 'xzf') {
      extractPackage(args);
      return Buffer.from('');
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  });

  if (childEnvironment.action === 'add') {
    const { repertoireAddCommand } = await import('../../commands/repertoire/add.js');
    await repertoireAddCommand('github:owner/repo@main', mutationOptions);
    return;
  }
  if (childEnvironment.action === 'remove') {
    const { repertoireRemoveCommand } = await import('../../commands/repertoire/remove.js');
    await repertoireRemoveCommand('@owner/repo', mutationOptions);
    return;
  }
  throw new Error('TAKT_REPERTOIRE_MUTATION_ACTION must be add or remove');
}, 15_000);

function requiredRoot(): string {
  return requiredEnvironment('root');
}

function requiredEnvironment(key: 'root' | 'readyPath'): string {
  const value = childEnvironment[key];
  if (!value) throw new Error(`Missing child environment: ${key}`);
  return value;
}

function tarListing(): string {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  return [
    `drwxr-xr-x 0 owner/repo 0 2026-06-01 12:00 owner-repo-${commit}/`,
    `-rw-r--r-- 0 owner/repo 0 2026-06-01 12:00 owner-repo-${commit}/takt-repertoire.yaml`,
    `-rw-r--r-- 0 owner/repo 0 2026-06-01 12:00 owner-repo-${commit}/facets/personas/coder.md`,
  ].join('\n');
}

function extractPackage(args: string[]): void {
  const destination = args[args.indexOf('-C') + 1];
  if (!destination) throw new Error('tar destination is required');
  mkdirSync(join(destination, 'facets', 'personas'), { recursive: true });
  writeFileSync(join(destination, 'takt-repertoire.yaml'), 'path: .\n');
  writeFileSync(join(destination, 'facets', 'personas', 'coder.md'), '# coder\n');
}
