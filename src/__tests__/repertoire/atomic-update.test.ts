/**
 * Tests for atomic package update (overwrite install).
 *
 * Covers:
 * - unknown .tmp/.bak residuals fail closed without deletion
 * - installation completes in staging before atomic publication
 * - validation failure removes owned staging and preserves the existing package
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cleanupResiduals,
  atomicReplace,
  type AtomicReplaceOptions,
} from '../../features/repertoire/atomic-update.js';

// ---------------------------------------------------------------------------
// cleanupResiduals
// ---------------------------------------------------------------------------

describe('cleanupResiduals', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-atomic-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails closed without removing a pre-existing .tmp directory', () => {
    // Given: a .tmp directory remains from a previous failed install
    const packageDir = join(tempDir, 'takt-fullstack');
    const tmpDir = join(tempDir, 'takt-fullstack.tmp');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'stale.yaml'), 'stale');

    let caught: unknown;
    try {
      cleanupResiduals(packageDir);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(existsSync(join(tmpDir, 'stale.yaml'))).toBe(true);
  });

  it('fails closed without removing a pre-existing .bak directory', () => {
    // Given: a .bak directory remains from a previous failed install
    const packageDir = join(tempDir, 'takt-fullstack');
    const bakDir = join(tempDir, 'takt-fullstack.bak');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(bakDir, { recursive: true });
    writeFileSync(join(bakDir, 'old.yaml'), 'old');

    let caught: unknown;
    try {
      cleanupResiduals(packageDir);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(existsSync(join(bakDir, 'old.yaml'))).toBe(true);
  });

  it('should succeed even when neither .tmp nor .bak exist', () => {
    // Given: no residual directories
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });

    // When: cleanup is performed
    // Then: no error thrown
    expect(() => cleanupResiduals(packageDir)).not.toThrow();
  });

  it('preserves both unknown residuals when both exist', () => {
    // Given: both residuals exist
    const packageDir = join(tempDir, 'takt-fullstack');
    const tmpDirPath = join(tempDir, 'takt-fullstack.tmp');
    const bakDir = join(tempDir, 'takt-fullstack.bak');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(tmpDirPath, { recursive: true });
    mkdirSync(bakDir, { recursive: true });

    expect(() => cleanupResiduals(packageDir))
      .toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));

    expect(existsSync(tmpDirPath)).toBe(true);
    expect(existsSync(bakDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// atomicReplace
// ---------------------------------------------------------------------------

describe('atomicReplace', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-atomic-replace-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should replace existing package and delete .bak on success', async () => {
    // Given: an existing package directory
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'old.yaml'), 'old content');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async (stagingDir) => {
        expect(stagingDir).not.toBe(packageDir);
        expect(existsSync(join(packageDir, 'old.yaml'))).toBe(true);
        writeFileSync(join(stagingDir, 'new.yaml'), 'new content');
      },
    };

    // When: atomicReplace is executed
    await atomicReplace(options);

    // Then: new content is in place, .bak is cleaned up
    expect(existsSync(join(packageDir, 'new.yaml'))).toBe(true);
    expect(existsSync(join(tempDir, 'takt-fullstack.bak'))).toBe(false);
  });

  it('should preserve existing package when install throws (validation failure)', async () => {
    // Given: an existing package with content
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'existing.yaml'), 'existing');

    const options: AtomicReplaceOptions = {
      packageDir,
      install: async (stagingDir) => {
        writeFileSync(join(stagingDir, 'partial.yaml'), 'partial');
        // Simulate validation failure
        throw new Error('Validation failed: empty package');
      },
    };

    // When: atomicReplace is executed with a failing install
    await expect(atomicReplace(options)).rejects.toThrow('Validation failed');

    // Then: existing package is preserved
    expect(existsSync(join(packageDir, 'existing.yaml'))).toBe(true);
    // .tmp directory should be cleaned up
    expect(existsSync(join(tempDir, 'takt-fullstack.tmp'))).toBe(false);
  });

  it('publishes a fully completed staging tree for a first install', async () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    let stagingDirSeen = '';

    await atomicReplace({
      packageDir,
      install: async (stagingDir) => {
        stagingDirSeen = stagingDir;
        writeFileSync(join(stagingDir, 'manifest.yaml'), 'complete');
        expect(existsSync(packageDir)).toBe(false);
      },
    });

    expect(stagingDirSeen).toBe(`${packageDir}.tmp`);
    expect(existsSync(join(packageDir, 'manifest.yaml'))).toBe(true);
    expect(existsSync(stagingDirSeen)).toBe(false);
  });

  it('preserves a foreign backup created during install and requires recovery', async () => {
    const packageDir = join(tempDir, 'takt-fullstack');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'original.yaml'), 'original');

    await expect(atomicReplace({
      packageDir,
      install: async (stagingDir) => {
        writeFileSync(join(stagingDir, 'new.yaml'), 'new');
        mkdirSync(`${packageDir}.bak`);
        writeFileSync(join(`${packageDir}.bak`, 'foreign.yaml'), 'foreign');
      },
    })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(existsSync(join(packageDir, 'original.yaml'))).toBe(true);
    expect(existsSync(join(`${packageDir}.tmp`, 'new.yaml'))).toBe(true);
    expect(existsSync(join(`${packageDir}.bak`, 'foreign.yaml'))).toBe(true);
  });

  it('preserves a foreign package that appears before first-install publication', async () => {
    const packageDir = join(tempDir, 'takt-fullstack');

    await expect(atomicReplace({
      packageDir,
      install: async (stagingDir) => {
        writeFileSync(join(stagingDir, 'new.yaml'), 'new');
        mkdirSync(packageDir);
        writeFileSync(join(packageDir, 'foreign.yaml'), 'foreign');
      },
    })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(existsSync(join(packageDir, 'foreign.yaml'))).toBe(true);
    expect(existsSync(join(`${packageDir}.tmp`, 'new.yaml'))).toBe(true);
  });

  it('preserves data when the package parent identity changes during install', async () => {
    const packageDir = join(tempDir, 'owner', 'takt-fullstack');
    const displacedOwner = join(tempDir, 'owner.displaced');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'original.yaml'), 'original');

    await expect(atomicReplace({
      packageDir,
      install: async (stagingDir) => {
        writeFileSync(join(stagingDir, 'new.yaml'), 'new');
        renameSync(join(tempDir, 'owner'), displacedOwner);
        mkdirSync(join(tempDir, 'owner'));
        mkdirSync(packageDir);
        writeFileSync(join(packageDir, 'foreign.yaml'), 'foreign');
      },
    })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });

    expect(existsSync(join(packageDir, 'foreign.yaml'))).toBe(true);
    expect(existsSync(join(displacedOwner, 'takt-fullstack', 'original.yaml'))).toBe(true);
    expect(existsSync(join(displacedOwner, 'takt-fullstack.tmp', 'new.yaml'))).toBe(true);
  });
});
