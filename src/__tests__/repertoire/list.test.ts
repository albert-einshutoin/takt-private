/**
 * Tests for repertoire list display data retrieval.
 *
 * Covers:
 * - readPackageInfo(): reads description from takt-repertoire.yaml and ref/commit from .takt-repertoire-lock.yaml
 * - commit is truncated to first 7 characters for display
 * - listPackages(): enumerates all installed packages under repertoire/
 * - Multiple packages are correctly listed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readPackageInfoFromGlobalConfig,
  listPackagesFromGlobalConfig,
} from '../../features/repertoire/list.js';
import { acquireRepertoireCoordinationLease } from '../../features/repertoire/coordination-lease.js';

// ---------------------------------------------------------------------------
// readPackageInfo
// ---------------------------------------------------------------------------

describe('readPackageInfo', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-list-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readInfo(packageDir: string, scope: string) {
    return readPackageInfoFromGlobalConfig({
      globalConfigDir: tempDir,
      repertoireDir: join(tempDir, 'repertoire'),
      packageDir,
      scope,
    });
  }

  it('should read description from takt-repertoire.yaml', () => {
    // Given: a package directory with takt-repertoire.yaml and .takt-repertoire-lock.yaml
    const packageDir = join(tempDir, 'repertoire', '@nrslib', 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'takt-repertoire.yaml'),
      'description: フルスタック開発ワークフロー\n',
    );
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:nrslib/takt-fullstack
ref: v1.2.0
commit: abc1234def5678
imported_at: 2026-02-20T12:00:00.000Z
`,
    );

    // When: package info is read
    const info = readInfo(packageDir, '@nrslib/takt-fullstack');

    // Then: description, ref, and truncated commit are returned
    expect(info.scope).toBe('@nrslib/takt-fullstack');
    expect(info.description).toBe('フルスタック開発ワークフロー');
    expect(info.ref).toBe('v1.2.0');
    expect(info.commit).toBe('abc1234'); // first 7 chars
  });

  it('should truncate commit SHA to first 7 characters', () => {
    // Given: package with a long commit SHA
    const packageDir = join(tempDir, 'repertoire', '@nrslib', 'takt-security-facets');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'description: Security facets\n');
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:nrslib/takt-security-facets
ref: HEAD
commit: def5678901234567
imported_at: 2026-02-20T12:00:00.000Z
`,
    );

    // When: package info is read
    const info = readInfo(packageDir, '@nrslib/takt-security-facets');

    // Then: commit is 7 chars
    expect(info.commit).toBe('def5678');
    expect(info.commit).toHaveLength(7);
  });

  it('should handle package without description field', () => {
    // Given: takt-repertoire.yaml with no description
    const packageDir = join(tempDir, 'repertoire', '@acme', 'takt-backend');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'path: takt\n');
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:acme/takt-backend
ref: v2.0.0
commit: 789abcdef0123
imported_at: 2026-01-15T08:30:00.000Z
`,
    );

    // When: package info is read
    const info = readInfo(packageDir, '@acme/takt-backend');

    // Then: description is undefined (not present)
    expect(info.description).toBeUndefined();
    expect(info.ref).toBe('v2.0.0');
  });

  it('should use "HEAD" ref when package was imported without a tag', () => {
    // Given: package imported from default branch
    const packageDir = join(tempDir, 'repertoire', '@acme', 'no-tag-pkg');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'description: No tag\n');
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:acme/no-tag-pkg
ref: HEAD
commit: aabbccddeeff00
imported_at: 2026-02-01T00:00:00.000Z
`,
    );

    // When: package info is read
    const info = readInfo(packageDir, '@acme/no-tag-pkg');

    // Then: ref is "HEAD"
    expect(info.ref).toBe('HEAD');
  });

  it('should fallback to "HEAD" ref when lock file is absent', () => {
    // Given: package directory with no lock file
    const packageDir = join(tempDir, 'repertoire', '@acme', 'no-lock-pkg');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), 'description: No lock\n');
    // .takt-repertoire-lock.yaml intentionally not created

    // When: package info is read
    const info = readInfo(packageDir, '@acme/no-lock-pkg');

    // Then: ref defaults to "HEAD" when lock file is missing
    expect(info.ref).toBe('HEAD');
    expect(info.description).toBe('No lock');
  });
});

// ---------------------------------------------------------------------------
// listPackages
// ---------------------------------------------------------------------------

describe('listPackages', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-list-all-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createPackage(
    repertoireDir: string,
    owner: string,
    repo: string,
    description: string,
    ref: string,
    commit: string,
  ): void {
    const packageDir = join(repertoireDir, `@${owner}`, repo);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'takt-repertoire.yaml'), `description: ${description}\n`);
    writeFileSync(
      join(packageDir, '.takt-repertoire-lock.yaml'),
      `source: github:${owner}/${repo}
ref: ${ref}
commit: ${commit}
imported_at: 2026-02-20T12:00:00.000Z
`,
    );
  }

  function listForTest(repertoireDir: string) {
    return listPackagesFromGlobalConfig({ globalConfigDir: tempDir, repertoireDir });
  }

  function readForTest(packageDir: string, scope: string) {
    return readPackageInfoFromGlobalConfig({
      globalConfigDir: tempDir,
      repertoireDir: join(tempDir, 'repertoire'),
      packageDir,
      scope,
    });
  }

  it('should list all installed packages from repertoire directory', () => {
    // Given: repertoire directory with 3 packages
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'takt-fullstack', 'Fullstack workflow', 'v1.2.0', 'abc1234def5678');
    createPackage(repertoireDir, 'nrslib', 'takt-security-facets', 'Security facets', 'HEAD', 'def5678901234');
    createPackage(repertoireDir, 'acme-corp', 'takt-backend', 'Backend facets', 'v2.0.0', '789abcdef0123');

    // When: packages are listed
    const packages = listForTest(repertoireDir);

    // Then: all 3 packages are returned
    expect(packages).toHaveLength(3);
    const scopes = packages.map((p) => p.scope);
    expect(scopes).toContain('@nrslib/takt-fullstack');
    expect(scopes).toContain('@nrslib/takt-security-facets');
    expect(scopes).toContain('@acme-corp/takt-backend');
  });

  it('should return empty list when repertoire directory has no packages', () => {
    // Given: empty repertoire directory
    const repertoireDir = join(tempDir, 'repertoire');
    mkdirSync(repertoireDir, { recursive: true });

    // When: packages are listed
    const packages = listForTest(repertoireDir);

    // Then: empty list
    expect(packages).toHaveLength(0);
  });

  it('should include correct commit (truncated to 7 chars) for each package', () => {
    // Given: repertoire with one package
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'takt-fullstack', 'Fullstack', 'v1.2.0', 'abc1234def5678');

    // When: packages are listed
    const packages = listForTest(repertoireDir);

    // Then: commit is 7 chars
    const pkg = packages.find((p) => p.scope === '@nrslib/takt-fullstack')!;
    expect(pkg.commit).toBe('abc1234');
    expect(pkg.commit).toHaveLength(7);
  });

  it('fails immediately behind a writer and succeeds after release', async () => {
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'takt-fullstack', 'Fullstack', 'HEAD', 'abc1234def5678');
    const packageDir = join(repertoireDir, '@nrslib', 'takt-fullstack');
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: tempDir,
      mode: 'write',
    });
    try {
      expect(() => listForTest(repertoireDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      expect(() => readForTest(packageDir, '@nrslib/takt-fullstack')).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
    } finally {
      writer.release();
    }
    expect(listForTest(repertoireDir)).toHaveLength(1);
    expect(readForTest(packageDir, '@nrslib/takt-fullstack').commit).toBe('abc1234');
  });

  it('honors a writer held by another process', async () => {
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'takt-fullstack', 'Fullstack', 'HEAD', 'abc1234def5678');
    const readyPath = join(tempDir, 'child.ready');
    const releasePath = join(tempDir, 'child.release');
    const vitestEntry = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
    const childTest = fileURLToPath(new URL('./coordination-lease-child.test.ts', import.meta.url));
    const child = spawn(process.execPath, [vitestEntry, 'run', childTest], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TAKT_REPERTOIRE_LEASE_CHILD: '1',
        TAKT_REPERTOIRE_LEASE_CONFIG_DIR: tempDir,
        TAKT_REPERTOIRE_LEASE_READY_PATH: readyPath,
        TAKT_REPERTOIRE_LEASE_RELEASE_PATH: releasePath,
      },
      stdio: 'pipe',
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath) && Date.now() < deadline) await delay(10);
      expect(existsSync(readyPath)).toBe(true);
      expect(() => listForTest(repertoireDir)).toThrow(
        expect.objectContaining({ code: 'REPERTOIRE_BUSY' }),
      );
      writeFileSync(releasePath, 'release\n', { flag: 'wx', mode: 0o600 });
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.once('exit', resolveExit);
      });
      expect(exitCode).toBe(0);
      expect(listForTest(repertoireDir)).toHaveLength(1);
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    }
  }, 15_000);

  it('rejects traversal and symlink aliases without bypassing a writer', async () => {
    const repertoireDir = join(tempDir, 'repertoire');
    createPackage(repertoireDir, 'nrslib', 'real', 'Real', 'HEAD', 'abc1234def5678');
    const traversal = `${tempDir}/nested/../repertoire`;
    const repertoireAlias = join(tempDir, 'repertoire-alias');
    symlinkSync(repertoireDir, repertoireAlias, 'dir');
    const packageAlias = join(repertoireDir, '@nrslib', 'alias');
    symlinkSync('real', packageAlias, 'dir');
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: tempDir,
      mode: 'write',
    });
    try {
      for (const candidate of [traversal, repertoireAlias]) {
        expect(() => listPackagesFromGlobalConfig({
          globalConfigDir: tempDir,
          repertoireDir: candidate,
        })).toThrow(expect.objectContaining({ code: 'REPERTOIRE_BUSY' }));
      }
      expect(() => readPackageInfoFromGlobalConfig({
        globalConfigDir: tempDir,
        repertoireDir,
        packageDir: packageAlias,
        scope: '@nrslib/alias',
      })).toThrow(expect.objectContaining({ code: 'REPERTOIRE_BUSY' }));
    } finally {
      writer.release();
    }
    for (const candidate of [traversal, repertoireAlias]) {
      expect(() => listPackagesFromGlobalConfig({
        globalConfigDir: tempDir,
        repertoireDir: candidate,
      })).toThrow(expect.objectContaining({ code: 'UNSAFE_STATE' }));
    }
    expect(() => readPackageInfoFromGlobalConfig({
      globalConfigDir: tempDir,
      repertoireDir,
      packageDir: packageAlias,
      scope: '@nrslib/alias',
    })).toThrow(expect.objectContaining({ code: 'UNSAFE_STATE' }));
  });

  it('rejects accessor and Proxy options before lease I/O', () => {
    let reads = 0;
    const accessor = Object.defineProperties({}, {
      globalConfigDir: { get: () => { reads += 1; return tempDir; } },
      repertoireDir: { value: join(tempDir, 'repertoire') },
    });
    expect(() => listPackagesFromGlobalConfig(accessor as never)).toThrow(
      expect.objectContaining({ code: 'UNSAFE_STATE' }),
    );
    expect(reads).toBe(0);

    const proxy = new Proxy({
      globalConfigDir: tempDir,
      repertoireDir: join(tempDir, 'repertoire'),
    }, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => listPackagesFromGlobalConfig(proxy)).toThrow(
      expect.objectContaining({ code: 'UNSAFE_STATE' }),
    );
    expect(reads).toBe(0);
  });

  it('rejects an owner symlink instead of treating it as an empty repertoire', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const outsideOwner = join(tempDir, 'outside-owner');
    mkdirSync(repertoireDir, { recursive: true });
    mkdirSync(outsideOwner);
    symlinkSync(outsideOwner, join(repertoireDir, '@external'), 'dir');

    expect(() => listForTest(repertoireDir)).toThrow(
      expect.objectContaining({ code: 'UNSAFE_STATE' }),
    );
  });

  it('rejects package metadata symlinks while the target root has a writer', async () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const packageDir = join(repertoireDir, '@nrslib', 'linked');
    mkdirSync(packageDir, { recursive: true });
    const targetRoot = mkdtempSync(join(tmpdir(), 'takt-list-target-'));
    const targetRepertoire = join(targetRoot, 'repertoire');
    createPackage(targetRepertoire, 'nrslib', 'target', 'Target', 'HEAD', 'abc1234def5678');
    const targetManifest = join(targetRepertoire, '@nrslib', 'target', 'takt-repertoire.yaml');
    symlinkSync(targetManifest, join(packageDir, 'takt-repertoire.yaml'));
    const writer = await acquireRepertoireCoordinationLease({
      globalConfigDir: targetRoot,
      mode: 'write',
    });
    try {
      expect(() => readForTest(packageDir, '@nrslib/linked')).toThrow(
        expect.objectContaining({ code: 'UNSAFE_STATE' }),
      );
    } finally {
      writer.release();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('rejects hard-linked package metadata', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const packageDir = join(repertoireDir, '@nrslib', 'linked');
    mkdirSync(packageDir, { recursive: true });
    const source = join(tempDir, 'shared-manifest.yaml');
    writeFileSync(source, 'description: shared\n');
    linkSync(source, join(packageDir, 'takt-repertoire.yaml'));

    expect(() => readForTest(packageDir, '@nrslib/linked')).toThrow(
      expect.objectContaining({ code: 'UNSAFE_STATE' }),
    );
  });

  it('uses captured object intrinsics when snapshotting options', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    mkdirSync(repertoireDir, { recursive: true });
    const poisoned = vi.spyOn(Object, 'create').mockImplementation(() => {
      throw new Error('poisoned Object.create');
    });
    try {
      expect(listForTest(repertoireDir)).toEqual([]);
      expect(poisoned).not.toHaveBeenCalled();
    } finally {
      poisoned.mockRestore();
    }
  });
});
