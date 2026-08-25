/**
 * Unit tests for repertoire reference integrity scanner.
 *
 * Target: src/features/repertoire/remove.ts (findScopeReferences)
 *
 * Scanner searches for @scope package references in:
 *   - {root}/workflows/**\/*.yaml
 *   - {root}/provider-options/**\/*.yaml
 *   - {root}/preferences/workflow-categories.yaml
 *   - {root}/.takt/workflows/**\/*.yaml (project-level)
 *   - {root}/.takt/provider-options/**\/*.yaml (project-level)
 *
 * Detection criteria:
 *   - Matches "@{owner}/{repo}" substring in file contents
 *   - Plain names without "@" are NOT detected
 *   - References to a different @scope are NOT detected
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findScopeReferences } from '../features/repertoire/remove.js';
import {
  REFERENCE_MAX_FILES,
  REFERENCE_MAX_SINGLE_FILE_BYTES,
} from '../features/repertoire/remove.js';
import { makeScanConfig } from './helpers/repertoire-test-helpers.js';

describe('repertoire reference integrity: detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-ref-integrity-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U29: ~/.takt/workflows/ の @scope 参照を検出
  // Given: {root}/workflows/my-review.yaml に
  //        persona: "@nrslib/takt-ensemble-fixture/expert-coder" を含む
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  my-review.yaml が検出される
  it('should detect @scope reference in global workflows YAML', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = join(workflowsDir, 'my-review.yaml');
    writeFileSync(workflowFile, 'persona: "@nrslib/takt-ensemble-fixture/expert-coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === workflowFile)).toBe(true);
  });

  // U30: {root}/preferences/workflow-categories.yaml の @scope 参照を検出
  // Given: workflow-categories.yaml に @nrslib/takt-ensemble-fixture/expert を含む
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  workflow-categories.yaml が検出される
  it('should detect @scope reference in global workflow-categories.yaml', () => {
    const prefsDir = join(tempDir, 'preferences');
    mkdirSync(prefsDir, { recursive: true });
    const categoriesFile = join(prefsDir, 'workflow-categories.yaml');
    writeFileSync(categoriesFile, 'categories:\n  - "@nrslib/takt-ensemble-fixture/expert"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === categoriesFile)).toBe(true);
  });

  // U31: {root}/.takt/workflows/ の @scope 参照を検出
  // Given: プロジェクト {root}/.takt/workflows/proj.yaml に @scope 参照
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  proj.yaml が検出される
  it('should detect @scope reference in project-level workflows YAML', () => {
    const projectWorkflowsDir = join(tempDir, '.takt', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    const projFile = join(projectWorkflowsDir, 'proj.yaml');
    writeFileSync(projFile, 'persona: "@nrslib/takt-ensemble-fixture/expert-coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === projFile)).toBe(true);
  });

  it('should detect @scope reference in global provider-options YAML', () => {
    const providerOptionsDir = join(tempDir, 'provider-options');
    mkdirSync(providerOptionsDir, { recursive: true });
    const providerOptionsFile = join(providerOptionsDir, 'review.yaml');
    writeFileSync(providerOptionsFile, 'claude:\n  allowed_tools: ["@nrslib/takt-ensemble-fixture/tool"]');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === providerOptionsFile)).toBe(true);
  });

  it('should detect @scope reference in project-level provider-options YAML', () => {
    const providerOptionsDir = join(tempDir, '.takt', 'provider-options');
    mkdirSync(providerOptionsDir, { recursive: true });
    const providerOptionsFile = join(providerOptionsDir, 'review.yaml');
    writeFileSync(providerOptionsFile, 'extends: "@nrslib/takt-ensemble-fixture/review-readonly"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs.some((r) => r.filePath === providerOptionsFile)).toBe(true);
  });

  it('should scan workflow, provider-options, and categories targets from explicit config', () => {
    const workflowsDir = join(tempDir, 'custom-workflows');
    const providerOptionsDir = join(tempDir, 'custom-provider-options');
    const categoriesFile = join(tempDir, 'custom-categories.yaml');
    mkdirSync(workflowsDir, { recursive: true });
    mkdirSync(providerOptionsDir, { recursive: true });
    const workflowFile = join(workflowsDir, 'flow.yaml');
    const providerOptionsFile = join(providerOptionsDir, 'readonly.yaml');
    writeFileSync(workflowFile, 'persona: "@nrslib/takt-ensemble-fixture/coder"');
    writeFileSync(providerOptionsFile, 'extends: "@nrslib/takt-ensemble-fixture/review-readonly"');
    writeFileSync(categoriesFile, 'categories:\n  - "@nrslib/takt-ensemble-fixture/fullstack"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', {
      workflowDirs: [workflowsDir],
      providerOptionsDirs: [providerOptionsDir],
      categoriesFiles: [categoriesFile],
    });

    expect(refs.map((ref) => ref.filePath).sort()).toEqual([
      categoriesFile,
      providerOptionsFile,
      workflowFile,
    ].sort());
  });
});

describe('repertoire reference integrity: non-detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-ref-nodetect-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // U32: @scope なし参照は検出しない
  // Given: persona: "coder" のみ（@scope なし）
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  結果が空配列
  it('should not detect plain name references without @scope prefix', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'plain.yaml'), 'persona: "coder"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs).toHaveLength(0);
  });

  // U33: 別スコープは検出しない
  // Given: persona: "@other/package/name"
  // When:  findScopeReferences("@nrslib/takt-ensemble-fixture", config)
  // Then:  結果が空配列
  it('should not detect references to a different @scope package', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'other.yaml'), 'persona: "@other/package/name"');

    const refs = findScopeReferences('@nrslib/takt-ensemble-fixture', makeScanConfig(tempDir));

    expect(refs).toHaveLength(0);
  });
});

describe('repertoire reference integrity: fail-closed authorization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-ref-fail-closed-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects a partial scan when a discovered path cannot be inspected', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    symlinkSync('loop.yaml', join(workflowsDir, 'loop.yaml'));

    expect(() => findScopeReferences('@owner/repo', {
      ...makeScanConfig(tempDir),
      failClosed: true,
    })).toThrow(expect.objectContaining({ code: 'REFERENCE_SCAN_FAILED' }));
  });

  it('normalizes readdir failures without exposing path or raw cause', () => {
    const notDirectory = join(tempDir, 'not-a-directory');
    writeFileSync(notDirectory, 'secret-path-content');

    let caught: unknown;
    try {
      findScopeReferences('@owner/repo', {
        workflowDirs: [notDirectory],
        providerOptionsDirs: [],
        categoriesFiles: [],
        failClosed: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'REFERENCE_SCAN_FAILED',
      message: 'Repertoire reference scan could not be completed safely',
    });
    expect(caught).not.toHaveProperty('cause');
    expect(JSON.stringify(caught)).not.toContain(notDirectory);
  });

  it('detects references after mutable String and Array intrinsics are poisoned', () => {
    const workflowsDir = join(tempDir, 'workflows');
    const workflowFile = join(workflowsDir, 'flow.yaml');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(workflowFile, 'persona: "@owner/repo/coder"');
    const originalIncludes = String.prototype.includes;
    const originalEndsWith = String.prototype.endsWith;
    const originalPush = Array.prototype.push;
    let refs: ReturnType<typeof findScopeReferences>;
    try {
      String.prototype.includes = () => false;
      String.prototype.endsWith = () => false;
      Array.prototype.push = function poisonedPush(...items: unknown[]) {
        if (typeof items[0] === 'object' && items[0] !== null && 'filePath' in items[0]) {
          return this.length;
        }
        return originalPush.apply(this, items);
      };
      refs = findScopeReferences('@owner/repo', {
        workflowDirs: [workflowsDir],
        providerOptionsDirs: [],
        categoriesFiles: [],
        failClosed: true,
      });
    } finally {
      String.prototype.includes = originalIncludes;
      String.prototype.endsWith = originalEndsWith;
      Array.prototype.push = originalPush;
    }

    expect(refs!).toHaveLength(1);
    expect(refs![0]).toMatchObject({
      filePath: workflowFile,
      dev: expect.any(Number),
      ino: expect.any(Number),
      contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('fails closed when a reference file exceeds the bounded read budget', () => {
    const workflowsDir = join(tempDir, 'workflows');
    mkdirSync(workflowsDir);
    writeFileSync(
      join(workflowsDir, 'large.yaml'),
      Buffer.alloc(REFERENCE_MAX_SINGLE_FILE_BYTES + 1),
    );
    expect(() => findScopeReferences('@owner/repo', {
      workflowDirs: [workflowsDir],
      providerOptionsDirs: [],
      categoriesFiles: [],
      failClosed: true,
    })).toThrow(expect.objectContaining({ code: 'REFERENCE_SCAN_FAILED' }));
  });

  it('counts non-YAML directory entries against the scan budget', () => {
    const workflowsDir = join(tempDir, 'workflows-entry-budget');
    mkdirSync(workflowsDir);
    for (let index = 0; index <= REFERENCE_MAX_FILES; index += 1) {
      writeFileSync(join(workflowsDir, `ignored-${index}.txt`), 'x');
    }
    expect(() => findScopeReferences('@owner/repo', {
      workflowDirs: [workflowsDir],
      providerOptionsDirs: [],
      categoriesFiles: [],
      failClosed: true,
    })).toThrow(expect.objectContaining({ code: 'REFERENCE_SCAN_FAILED' }));
  });

  it.runIf(process.getuid?.() !== 0)('treats EACCES as failure rather than absence', () => {
    const denied = join(tempDir, 'denied');
    mkdirSync(denied);
    chmodSync(denied, 0o000);
    try {
      expect(() => findScopeReferences('@owner/repo', {
        workflowDirs: [join(denied, 'workflows')],
        providerOptionsDirs: [],
        categoriesFiles: [],
        failClosed: true,
      })).toThrow(expect.objectContaining({ code: 'REFERENCE_SCAN_FAILED' }));
    } finally {
      chmodSync(denied, 0o700);
    }
  });
});
