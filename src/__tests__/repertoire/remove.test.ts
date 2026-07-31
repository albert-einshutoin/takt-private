/**
 * Regression test for repertoireRemoveCommand scan configuration.
 *
 * Verifies that findScopeReferences is called with exactly the 3 spec-defined
 * scan locations:
 *   1. ~/.takt/workflows (global workflows dir)
 *   2. .takt/workflows (project workflows dir)
 *   3. ~/.takt/provider-options (global provider_options dir)
 *   4. .takt/provider-options (project provider_options dir)
 *   5. ~/.takt/preferences/workflow-categories.yaml (categories file)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  Stats: class {
    isDirectory() { return true; }
    isSymbolicLink() { return false; }
  },
  existsSync: vi.fn().mockReturnValue(true),
  lstatSync: vi.fn(() => ({
    dev: 1,
    ino: 1,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  })),
  readdirSync: vi.fn().mockReturnValue(['unknown-file']),
  realpathSync: vi.fn((path: string) => path),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
}));

const {
  mockAcquireCoordinationLease,
  mockReleaseCoordinationLease,
  mockCaptureDirectoryTreeProof,
  mockDetachToMaintenance,
} = vi.hoisted(() => ({
  mockAcquireCoordinationLease: vi.fn(),
  mockReleaseCoordinationLease: vi.fn(),
  mockCaptureDirectoryTreeProof: vi.fn(),
  mockDetachToMaintenance: vi.fn(),
}));

vi.mock('../../features/repertoire/coordination-lease.js', () => ({
  acquireRepertoireCoordinationLease: mockAcquireCoordinationLease,
}));

vi.mock('../../features/repertoire/filesystem-proof.js', () => ({
  captureDirectoryTreeProof: mockCaptureDirectoryTreeProof,
  sameTreeProof: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock('../../features/repertoire/remove.js', () => ({
  findScopeReferences: vi.fn().mockReturnValue([]),
  shouldRemoveOwnerDir: vi.fn().mockReturnValue(false),
}));

vi.mock('../../features/repertoire/maintenance-transaction.js', () => ({
  detachToMaintenance: mockDetachToMaintenance,
}));

vi.mock('../../infra/config/paths.js', () => ({
  getRepertoireDir: vi.fn().mockReturnValue('/home/user/.takt/repertoire'),
  getRepertoirePackageDir: vi.fn().mockReturnValue('/home/user/.takt/repertoire/@owner/repo'),
  getGlobalConfigDir: vi.fn().mockReturnValue('/home/user/.takt'),
  getGlobalWorkflowsDir: vi.fn().mockReturnValue('/home/user/.takt/workflows'),
  getProjectWorkflowsDir: vi.fn().mockReturnValue('/project/.takt/workflows'),
  getGlobalProviderOptionsDir: vi.fn().mockReturnValue('/home/user/.takt/provider-options'),
  getProjectProviderOptionsDir: vi.fn().mockReturnValue('/project/.takt/provider-options'),
}));

vi.mock('../../infra/config/global/index.js', () => ({
  getWorkflowCategoriesPath: vi.fn().mockReturnValue('/home/user/.takt/preferences/workflow-categories.yaml'),
}));

vi.mock('../../shared/prompt/index.js', () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks are declared
// ---------------------------------------------------------------------------

import { repertoireRemoveCommand } from '../../commands/repertoire/remove.js';
import { findScopeReferences } from '../../features/repertoire/remove.js';
import { getWorkflowCategoriesPath } from '../../infra/config/global/index.js';
import { confirm } from '../../shared/prompt/index.js';
import { success } from '../../shared/ui/index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repertoireRemoveCommand — scan configuration', () => {
  beforeEach(() => {
    vi.mocked(rmSync).mockReset();
    vi.mocked(readdirSync).mockReset().mockImplementation((path) => (
      String(path).includes('.remove-') ? ['package.quarantined'] : ['unknown-file']
    ) as never);
    vi.mocked(rmdirSync).mockReset();
    vi.mocked(lstatSync).mockReset();
    mockAcquireCoordinationLease.mockReset();
    mockDetachToMaintenance.mockReset();
    mockReleaseCoordinationLease.mockReset();
    vi.mocked(success).mockClear();
    vi.mocked(findScopeReferences).mockClear();
    vi.mocked(findScopeReferences).mockReturnValue([]);
    vi.mocked(getWorkflowCategoriesPath).mockClear();
    vi.mocked(getWorkflowCategoriesPath).mockReturnValue('/home/user/.takt/preferences/workflow-categories.yaml');
    vi.mocked(confirm).mockResolvedValue(false);
    vi.mocked(realpathSync).mockImplementation((path) => String(path));
    vi.mocked(lstatSync).mockReturnValue({
      dev: 1,
      ino: 1,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as ReturnType<typeof lstatSync>);
    mockAcquireCoordinationLease.mockResolvedValue({
      mode: 'write',
      release: mockReleaseCoordinationLease,
    });
    mockCaptureDirectoryTreeProof.mockReturnValue({
      dev: 1,
      ino: 1,
      mode: 0o40700,
      realpath: '/home/user/.takt/repertoire/@owner/repo',
      contentFingerprint: 'stable',
    });
  });

  it('should call findScopeReferences with workflow, provider-options, and categories scan targets', async () => {
    // When: remove command is invoked (confirm returns false → no deletion)
    await repertoireRemoveCommand('@owner/repo');

    // Then: findScopeReferences is called once
    expect(findScopeReferences).toHaveBeenCalledOnce();

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: exactly 2 workflow directories
    expect(scanConfig.workflowDirs).toHaveLength(2);

    // Then: exactly 2 provider-options directories
    expect(scanConfig.providerOptionsDirs).toHaveLength(2);

    // Then: exactly 1 categories file
    expect(scanConfig.categoriesFiles).toHaveLength(1);

    // Removal decisions must never rely on a partial, best-effort scan.
    expect(scanConfig.failClosed).toBe(true);
  });

  it('should include global workflows dir in scan', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: global workflows dir is in the scan list
    expect(scanConfig.workflowDirs).toContain('/home/user/.takt/workflows');
  });

  it('should include project workflows dir in scan', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: project workflows dir is in the scan list
    expect(scanConfig.workflowDirs).toContain('/project/.takt/workflows');
  });

  it('should include global provider-options dir in scan', async () => {
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    expect(scanConfig.providerOptionsDirs).toContain('/home/user/.takt/provider-options');
  });

  it('should include project provider-options dir in scan', async () => {
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    expect(scanConfig.providerOptionsDirs).toContain('/project/.takt/provider-options');
  });

  it('should include preferences/workflow-categories.yaml in categoriesFiles', async () => {
    // When: remove command is invoked
    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: the categories file path is correct
    expect(scanConfig.categoriesFiles).toContain(
      join('/home/user/.takt', 'preferences', 'workflow-categories.yaml'),
    );
  });

  it('should use the resolved workflow categories path override', async () => {
    vi.mocked(getWorkflowCategoriesPath).mockReturnValue('/custom/workflow-categories.yaml');

    await repertoireRemoveCommand('@owner/repo');

    const [, scanConfig] = vi.mocked(findScopeReferences).mock.calls[0]!;

    expect(getWorkflowCategoriesPath).toHaveBeenCalledWith(process.cwd());
    expect(scanConfig.categoriesFiles).toEqual(['/custom/workflow-categories.yaml']);
  });

  it('should pass the scope as the first argument to findScopeReferences', async () => {
    // When: remove command is invoked with a scope
    await repertoireRemoveCommand('@owner/repo');

    const [scope] = vi.mocked(findScopeReferences).mock.calls[0]!;

    // Then: scope is passed correctly
    expect(scope).toBe('@owner/repo');
  });

  it('should reject a scope whose repo segment escapes the package directory', async () => {
    await expect(repertoireRemoveCommand('@owner/../../tmp/target')).rejects.toThrow();

    expect(findScopeReferences).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
  });

  it('should reject deletion when the resolved package directory is outside the repertoire directory', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(realpathSync).mockImplementation((path) => (
      String(path) === '/home/user/.takt/repertoire/@owner/repo' ? '/tmp/target' : String(path)
    ));

    await expect(repertoireRemoveCommand('@owner/repo')).rejects.toThrow(/escapes repertoire directory/);

    expect(rmSync).not.toHaveBeenCalled();
  });

  it('holds no writer during reference scan or confirmation and encloses the full deletion', async () => {
    let referenceScans = 0;
    vi.mocked(findScopeReferences).mockImplementation(() => {
      if (referenceScans++ === 0) expect(mockAcquireCoordinationLease).not.toHaveBeenCalled();
      return [];
    });
    vi.mocked(confirm).mockImplementation(async () => {
      expect(mockAcquireCoordinationLease).not.toHaveBeenCalled();
      return true;
    });

    await repertoireRemoveCommand('@owner/repo');

    expect(mockAcquireCoordinationLease).toHaveBeenCalledWith({
      globalConfigDir: '/home/user/.takt',
      mode: 'write',
    });
    expect(mockDetachToMaintenance).toHaveBeenCalledWith(expect.objectContaining({
      globalConfigDir: '/home/user/.takt',
      sourceDir: '/home/user/.takt/repertoire/@owner/repo',
      kind: 'payload',
    }));
    expect(mockDetachToMaintenance.mock.invocationCallOrder.at(-1))
      .toBeLessThan(mockReleaseCoordinationLease.mock.invocationCallOrder[0]!);
  });

  it.each(['ABORTED', 'TIMEOUT', 'UNSAFE_STATE'])(
    'performs no deletion when writer acquisition fails with %s',
    async (code) => {
      vi.mocked(confirm).mockResolvedValue(true);
      mockAcquireCoordinationLease.mockRejectedValueOnce(Object.assign(new Error(code), { code }));

      await expect(repertoireRemoveCommand('@owner/repo')).rejects.toMatchObject({ code });

      expect(rmSync).not.toHaveBeenCalled();
      expect(mockReleaseCoordinationLease).not.toHaveBeenCalled();
    },
  );

  it('revalidates package identity and releases without deletion after lease acquisition', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    mockCaptureDirectoryTreeProof
      .mockReturnValueOnce({ dev: 1, ino: 1, contentFingerprint: 'initial' })
      .mockReturnValueOnce({ dev: 1, ino: 2, contentFingerprint: 'changed' });

    await expect(repertoireRemoveCommand('@owner/repo'))
      .rejects.toThrow(/changed while waiting/);

    expect(rmSync).not.toHaveBeenCalled();
    expect(mockReleaseCoordinationLease).toHaveBeenCalledOnce();
  });

  it('rescans references after acquisition and requires renewed confirmation when they change', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(findScopeReferences)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ filePath: '/project/.takt/workflows/new.yaml' }]);

    await expect(repertoireRemoveCommand('@owner/repo'))
      .rejects.toThrow(/references changed while waiting/);

    expect(findScopeReferences).toHaveBeenCalledTimes(2);
    expect(rmSync).not.toHaveBeenCalled();
    expect(mockReleaseCoordinationLease).toHaveBeenCalledOnce();
  });

  it('releases the writer when deletion throws', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    mockDetachToMaintenance.mockImplementationOnce(() => {
      throw new Error('delete failed');
    });

    await expect(repertoireRemoveCommand('@owner/repo')).rejects.toThrow('delete failed');

    expect(mockReleaseCoordinationLease).toHaveBeenCalledOnce();
  });

  it('fails closed when the fresh reference scan cannot be completed', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(findScopeReferences)
      .mockReturnValueOnce([])
      .mockImplementationOnce(() => { throw new Error('reference read failed'); });

    await expect(repertoireRemoveCommand('@owner/repo'))
      .rejects.toThrow('reference read failed');

    expect(mockDetachToMaintenance).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect(mockReleaseCoordinationLease).toHaveBeenCalledOnce();
  });

  it('keeps an owner directory containing an unknown file', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(readdirSync).mockImplementation((path) => (
      String(path).includes('.remove-') ? ['package.quarantined'] : ['unknown-file']
    ) as never);

    await repertoireRemoveCommand('@owner/repo');

    expect(rmdirSync).not.toHaveBeenCalled();
  });

  it('preserves the maintenance payload when detach cannot be proven', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    mockDetachToMaintenance.mockImplementationOnce(() => {
      throw Object.assign(new Error('Repertoire package recovery is required'), {
        code: 'RECOVERY_REQUIRED',
      });
    });

    await expect(repertoireRemoveCommand('@owner/repo'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(rmSync).not.toHaveBeenCalled();
    expect(mockReleaseCoordinationLease).toHaveBeenCalledOnce();
  });

  it('removes an exactly empty owner directory non-recursively', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(readdirSync).mockImplementation((path) => (
      String(path).includes('.remove-') ? ['package.quarantined'] : []
    ) as never);

    await repertoireRemoveCommand('@owner/repo');

    expect(rmdirSync).toHaveBeenCalledWith('/home/user/.takt/repertoire/@owner');
  });

  it('does not publish success when writer release requires recovery', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    mockReleaseCoordinationLease.mockImplementationOnce(() => {
      throw Object.assign(new Error('release recovery required'), { code: 'RECOVERY_REQUIRED' });
    });

    await expect(repertoireRemoveCommand('@owner/repo'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(success).not.toHaveBeenCalled();
  });

  it('redacts owner cleanup filesystem failures', async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(rmdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('/secret/owner'), { code: 'EACCES' });
    });
    await expect(repertoireRemoveCommand('@owner/repo')).rejects.toEqual(
      expect.objectContaining({
        code: 'RECOVERY_REQUIRED',
        message: 'Repertoire package recovery is required',
      }),
    );
  });
});
