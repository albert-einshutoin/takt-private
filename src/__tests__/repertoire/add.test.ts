import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  mockMkdtempSync,
  mockMkdirSync,
  mockCopyFileSync,
  mockExistsSync,
  mockReadFileSync,
  mockWriteFileSync,
  mockRmSync,
  mockLstatSync,
  mockRealpathSync,
  mockExecFileSync,
  mockResolveRef,
  mockResolveRepertoireConfigPath,
  mockAtomicReplace,
  mockCleanupResiduals,
  mockAcquireCoordinationLease,
  mockReleaseCoordinationLease,
  secureTempDir,
} = vi.hoisted(() => ({
  mockMkdtempSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockRmSync: vi.fn(),
  mockLstatSync: vi.fn(),
  mockRealpathSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockResolveRef: vi.fn(),
  mockResolveRepertoireConfigPath: vi.fn(),
  mockAtomicReplace: vi.fn(),
  mockCleanupResiduals: vi.fn(),
  mockAcquireCoordinationLease: vi.fn(),
  mockReleaseCoordinationLease: vi.fn(),
  secureTempDir: '/secure/tmp/takt-import-a1b2c3',
}));

vi.mock('node:fs', () => ({
  default: {
    mkdtempSync: mockMkdtempSync,
    mkdirSync: mockMkdirSync,
    copyFileSync: mockCopyFileSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    rmSync: mockRmSync,
    lstatSync: mockLstatSync,
    realpathSync: mockRealpathSync,
  },
  mkdtempSync: mockMkdtempSync,
  mkdirSync: mockMkdirSync,
  copyFileSync: mockCopyFileSync,
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  rmSync: mockRmSync,
  lstatSync: mockLstatSync,
  realpathSync: mockRealpathSync,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../infra/config/paths.js', () => ({
  getBuiltinProviderOptionsDir: vi.fn(() => '/builtin/ja/provider-options'),
  getGlobalProviderOptionsDir: vi.fn(() => '/home/user/.takt/provider-options'),
  getProjectProviderOptionsDir: vi.fn(() => '/project/.takt/provider-options'),
  getRepertoireDir: vi.fn(() => '/home/user/.takt/repertoire'),
  getRepertoirePackageDir: vi.fn(() => '/home/user/.takt/repertoire/@owner/repo'),
  getGlobalConfigDir: vi.fn(() => '/home/user/.takt'),
}));

vi.mock('../../infra/config/resolveWorkflowConfigValue.js', () => ({
  resolveWorkflowConfigValues: vi.fn(() => ({ language: 'ja' })),
}));

vi.mock('../../features/repertoire/github-ref-resolver.js', () => ({
  resolveRef: mockResolveRef,
}));

vi.mock('../../features/repertoire/tar-parser.js', () => ({
  parseTarVerboseListing: vi.fn(() => ({
    firstDirEntry: 'owner-repo-deadbeef',
    includePaths: ['owner-repo-deadbeef/facets/personas/coder.md'],
  })),
}));

vi.mock('../../features/repertoire/takt-repertoire-config.js', () => ({
  parseTaktRepertoireConfig: vi.fn(() => ({ path: '.' })),
  validateTaktRepertoirePath: vi.fn(),
  validateMinVersion: vi.fn(),
  isVersionCompatible: vi.fn(() => true),
  checkPackageHasContentWithContext: vi.fn(),
  validateRealpathInsideRoot: vi.fn(),
  resolveRepertoireConfigPath: mockResolveRepertoireConfigPath,
}));

vi.mock('../../features/repertoire/file-filter.js', () => ({
  collectCopyTargets: vi.fn(() => [{
    absolutePath: `${secureTempDir}/extract/facets/personas/coder.md`,
    relativePath: 'facets/personas/coder.md',
  }]),
}));

vi.mock('../../features/repertoire/atomic-update.js', () => ({
  cleanupResiduals: mockCleanupResiduals,
  atomicReplace: mockAtomicReplace,
}));

vi.mock('../../features/repertoire/coordination-lease.js', () => ({
  acquireRepertoireCoordinationLease: mockAcquireCoordinationLease,
}));

vi.mock('../../features/repertoire/pack-summary.js', () => ({
  PACKAGE_PROVIDER_OPTIONS_DIR: '/__takt_repertoire_package__/provider-options',
  summarizeFacetsByType: vi.fn(() => 'personas: 1'),
  detectEditWorkflows: vi.fn(() => []),
  formatEditWorkflowWarnings: vi.fn(() => []),
}));

vi.mock('../../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { repertoireAddCommand } from '../../commands/repertoire/add.js';
import { collectCopyTargets } from '../../features/repertoire/file-filter.js';
import { detectEditWorkflows } from '../../features/repertoire/pack-summary.js';
import { cleanupResiduals } from '../../features/repertoire/atomic-update.js';
import { confirm } from '../../shared/prompt/index.js';

const mockCollectCopyTargets = vi.mocked(collectCopyTargets);
const mockDetectEditWorkflows = vi.mocked(detectEditWorkflows);
const mockConfirm = vi.mocked(confirm);

describe('repertoireAddCommand temporary directory handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtempSync.mockReturnValue(secureTempDir);
    mockExistsSync.mockImplementation((target: string) => (
      target === secureTempDir || target === '/home/user/.takt/repertoire'
    ));
    mockLstatSync.mockReturnValue({ dev: 1, ino: 1, isDirectory: () => true });
    mockRealpathSync.mockImplementation((target: string) => target);
    mockAcquireCoordinationLease.mockResolvedValue({
      mode: 'write',
      release: mockReleaseCoordinationLease,
    });
    mockReadFileSync.mockReturnValue('path: .');
    mockResolveRef.mockReturnValue('main');
    mockResolveRepertoireConfigPath.mockReturnValue(join(secureTempDir, 'extract', '.takt', 'takt-repertoire.yaml'));
    mockAtomicReplace.mockImplementation(async ({ install }: { install: () => Promise<void> }) => {
      await install();
    });
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'api') return Buffer.from('tarball');
      if (args[0] === 'tvzf') {
        return 'drwxr-xr-x  0 owner/repo 0 2026-06-01 12:00 owner-repo-deadbeef/\n'
          + '-rw-r--r--  0 owner/repo 0 2026-06-01 12:00 owner-repo-deadbeef/facets/personas/coder.md\n';
      }
      return Buffer.from('');
    });
  });

  it('should create import artifacts under a mkdtemp-created directory', async () => {
    await repertoireAddCommand('github:owner/repo@main');

    expect(mockMkdtempSync).toHaveBeenCalledWith(join(tmpdir(), 'takt-import-'));
    expect(mockMkdirSync).toHaveBeenCalledWith(join(secureTempDir, 'extract'), { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(join(secureTempDir, 'archive.tar.gz'), Buffer.from('tarball'));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      join(secureTempDir, 'include.txt'),
      'owner-repo-deadbeef/facets/personas/coder.md\n',
    );
    expect(mockResolveRepertoireConfigPath).toHaveBeenCalledWith(join(secureTempDir, 'extract'));
  });

  it('should create a missing TMPDIR before creating import artifacts', async () => {
    const originalTmpDir = process.env.TMPDIR;
    const missingTmpDir = join(tmpdir(), 'takt-repertoire-missing-tmp');
    process.env.TMPDIR = missingTmpDir;

    try {
      await repertoireAddCommand('github:owner/repo@main');

      expect(mockMkdirSync).toHaveBeenCalledWith(missingTmpDir, { recursive: true });
      expect(mockMkdtempSync).toHaveBeenCalledWith(join(missingTmpDir, 'takt-import-'));
    } finally {
      if (originalTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpDir;
      }
    }
  });

  it('should clean up the mkdtemp-created directory once', async () => {
    await repertoireAddCommand('github:owner/repo@main');

    expect(mockRmSync).toHaveBeenCalledOnce();
    expect(mockRmSync).toHaveBeenCalledWith(secureTempDir, { recursive: true, force: true });
  });

  it('should pass provider-options package YAMLs to edit workflow detection', async () => {
    const workflowPath = `${secureTempDir}/extract/workflows/workflow.yaml`;
    const providerOptionsPath = `${secureTempDir}/extract/provider-options/edit.yaml`;
    const workflowYaml = 'steps:\n  - name: run\n    provider_options:\n      extends: edit\n';
    const providerOptionsYaml = 'claude:\n  allowed_tools: [Bash]\n';

    mockCollectCopyTargets.mockReturnValue([
      { absolutePath: workflowPath, relativePath: 'workflows/workflow.yaml' },
      { absolutePath: providerOptionsPath, relativePath: 'provider-options/edit.yaml' },
    ]);
    mockReadFileSync.mockImplementation((target: string) => {
      if (target === workflowPath) {
        return workflowYaml;
      }
      if (target === providerOptionsPath) {
        return providerOptionsYaml;
      }
      return 'path: .';
    });

    await repertoireAddCommand('github:owner/repo@main');

    expect(mockDetectEditWorkflows).toHaveBeenCalledWith(
      [{
        name: 'workflow.yaml',
        content: workflowYaml,
        relativePath: 'workflows/workflow.yaml',
      }],
      [{
        name: 'edit.yaml',
        content: providerOptionsYaml,
        relativePath: 'provider-options/edit.yaml',
      }],
      {
        providerOptionsCandidateDirs: [
          '/project/.takt/provider-options',
          '/home/user/.takt/provider-options',
          '/builtin/ja/provider-options',
        ],
        providerOptionsScopedCandidateDirs: new Map([
          ['owner/repo', ['/__takt_repertoire_package__/provider-options']],
        ]),
        context: {
          projectDir: process.cwd(),
          lang: 'ja',
          workflowDir: '/home/user/.takt/repertoire/@owner/repo/workflows',
          repertoireDir: '/home/user/.takt/repertoire',
        },
      },
    );
  });

  it('holds no writer lease during network and confirmation, then encloses every package mutation', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      expect(mockAcquireCoordinationLease).not.toHaveBeenCalled();
      if (args[0] === 'api') return Buffer.from('tarball');
      if (args[0] === 'tvzf') {
        return 'drwxr-xr-x 0 owner/repo 0 2026-06-01 12:00 owner-repo-deadbeef/\n';
      }
      return Buffer.from('');
    });
    mockConfirm.mockImplementation(async () => {
      expect(mockAcquireCoordinationLease).not.toHaveBeenCalled();
      return true;
    });

    await repertoireAddCommand('github:owner/repo@main');

    expect(mockAcquireCoordinationLease).toHaveBeenCalledWith({
      globalConfigDir: '/home/user/.takt',
      mode: 'write',
    });
    expect(mockAcquireCoordinationLease.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(cleanupResiduals).mock.invocationCallOrder[0]!);
    expect(vi.mocked(cleanupResiduals).mock.invocationCallOrder[0])
      .toBeLessThan(mockAtomicReplace.mock.invocationCallOrder[0]!);
    expect(mockAtomicReplace.mock.invocationCallOrder[0])
      .toBeLessThan(mockReleaseCoordinationLease.mock.invocationCallOrder[0]!);
  });

  it.each(['ABORTED', 'TIMEOUT', 'UNSAFE_STATE'])(
    'performs no package mutation when writer acquisition fails with %s',
    async (code) => {
      mockAcquireCoordinationLease.mockRejectedValueOnce(Object.assign(new Error(code), { code }));

      await expect(repertoireAddCommand('github:owner/repo@main')).rejects.toMatchObject({ code });

      expect(mockCleanupResiduals).not.toHaveBeenCalled();
      expect(mockAtomicReplace).not.toHaveBeenCalled();
      expect(mockReleaseCoordinationLease).not.toHaveBeenCalled();
    },
  );

  it('releases without mutation when package existence changes while waiting for the writer', async () => {
    let leaseAcquired = false;
    mockAcquireCoordinationLease.mockImplementationOnce(async () => {
      leaseAcquired = true;
      return { mode: 'write', release: mockReleaseCoordinationLease };
    });
    mockExistsSync.mockImplementation((target: string) => {
      if (target === secureTempDir || target === '/home/user/.takt/repertoire') return true;
      if (target === '/home/user/.takt/repertoire/@owner/repo') return leaseAcquired;
      return false;
    });

    await expect(repertoireAddCommand('github:owner/repo@main'))
      .rejects.toThrow(/changed while waiting/);

    expect(mockCleanupResiduals).not.toHaveBeenCalled();
    expect(mockAtomicReplace).not.toHaveBeenCalled();
    expect(mockReleaseCoordinationLease).toHaveBeenCalledOnce();
  });
});
