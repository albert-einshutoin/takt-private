import {
  appendFileSync,
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as projectTemplate from '../../features/project-template/index.js';
import {
  areProjectTemplateFileStatsEqual,
  readBoundedProjectTemplateFile,
} from '../../features/project-template/bounded-file-read.js';
type Classification = 'portable-candidate' | 'project-owned' | 'excluded' | 'blocked';
interface ClassificationResult {
  relativePath: string;
  classification: Classification;
  reasonCode: string;
  summary: string;
  bytes: number;
  mode?: string;
  sha256?: string;
  suggestedPolicy?: string;
  detectedCapabilities: { path: string; capabilities: string[] };
  warnings: string[];
}
interface ScanResult {
  scanStatus: 'complete' | 'incomplete' | 'blocked';
  canExport: boolean;
  reviewRequired: boolean;
  entries: ClassificationResult[];
  counts: { nodes: number; files: number; bytes: number };
}
const api = projectTemplate as unknown as Record<string, unknown>;
const classify = api['classifyProjectTemplateEntry'] as (input: {
  relativePath: string;
  content?: Uint8Array;
  bytes: number;
  mode?: string;
  sha256?: string;
}) => ClassificationResult;
const scan = api['scanProjectTemplateDirectory'] as (
  root: string,
  options?: Record<string, number>,
) => Promise<ScanResult>;
const encoder = new TextEncoder();
const tempRoots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-classifier-'));
  tempRoots.push(root);
  return root;
}
function write(root: string, relativePath: string, content: string, mode = 0o644): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { mode });
}
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
describe('project template pure classifier', () => {
  it('should expose the pure classifier and filesystem adapter publicly', () => {
    expect(typeof api['classifyProjectTemplateEntry']).toBe('function');
    expect(typeof api['scanProjectTemplateDirectory']).toBe('function');
  });
  it.each([
    ['config.yaml', 'project-owned', 'PROJECT_CONFIG', 'merge'],
    ['devloopd.yaml', 'project-owned', 'PROJECT_CONFIG', 'merge'],
    ['workflows/shared.yaml', 'portable-candidate', 'SHARED_WORKFLOW'],
    ['facets/reviewer.md', 'portable-candidate', 'SHARED_FACET'],
    ['provider-options/review.yaml', 'portable-candidate', 'SHARED_PROVIDER_OPTIONS'],
    ['automation/release.sh', 'project-owned', 'PROJECT_AUTOMATION', 'scaffold'],
    ['quality-gates/release.yaml', 'project-owned', 'PROJECT_QUALITY_GATE'],
    ['quality-gates/logs/output.log', 'excluded', 'RUNTIME_STATE'],
    ['runs/state.json', 'excluded', 'RUNTIME_STATE'],
    ['tmp/cache.bin', 'excluded', 'RUNTIME_STATE'],
    ['worktrees/run.json', 'excluded', 'RUNTIME_STATE'],
    ['tasks/1.json', 'excluded', 'RUNTIME_STATE'],
    ['completed/1.json', 'excluded', 'RUNTIME_STATE'],
    ['logs/output.log', 'excluded', 'RUNTIME_STATE'],
    ['session/state.json', 'excluded', 'RUNTIME_STATE'],
    ['persona/default.json', 'excluded', 'RUNTIME_STATE'],
    ['staged/state.json', 'excluded', 'RUNTIME_STATE'],
    ['cache/index.json', 'excluded', 'RUNTIME_STATE'],
    ['.devloop/state.json', 'excluded', 'RUNTIME_STATE'],
    ['.env.local', 'blocked', 'SENSITIVE_FILENAME'],
    ['credentials.json', 'blocked', 'SENSITIVE_FILENAME'],
    ['private-key.pem', 'blocked', 'SENSITIVE_FILENAME'],
    ['secrets.yaml', 'blocked', 'SENSITIVE_FILENAME'],
    ['workflows/readme.txt', 'excluded', 'UNKNOWN_DEFAULT_DENY'],
    ['facets/reviewer.yaml', 'excluded', 'UNKNOWN_DEFAULT_DENY'],
    ['provider-options/review.md', 'excluded', 'UNKNOWN_DEFAULT_DENY'],
    ['notes/unknown.md', 'excluded', 'UNKNOWN_DEFAULT_DENY'],
  ])('should classify %s with default-deny semantics', (
    relativePath,
    classification,
    reasonCode,
    suggestedPolicy,
  ) => {
    const result = classify({
      relativePath,
      content: encoder.encode('safe fixture content'),
      bytes: 20,
      mode: '0644',
      sha256: 'a'.repeat(64),
    });
    expect(result).toMatchObject({
      relativePath,
      classification,
      reasonCode,
      ...(suggestedPolicy === undefined ? {} : { suggestedPolicy }),
    });
  });
  it('should consume anonymized cross-project fixture classifications', () => {
    const fixturePath = fileURLToPath(new URL('../fixtures/project-template/classifier-corpus.json', import.meta.url));
    const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<Record<string, string>>;
    for (const fixture of corpus) {
      const result = classify({
        relativePath: fixture['path']!,
        content: encoder.encode(fixture['content']!),
        bytes: fixture['content']!.length,
        mode: '0644',
        sha256: 'a'.repeat(64),
      });
      expect(result).toMatchObject({
        classification: fixture['classification'],
        reasonCode: fixture['reasonCode'],
      });
    }
  });
  it.each([
    'api_key=synthetic-secret-value',
    'Authorization: Bearer synthetic-token-value',
    '-----BEGIN PRIVATE KEY-----\\nsynthetic\\n-----END PRIVATE KEY-----',
    'ghp_syntheticcredential123456',
  ])('should block sensitive content without returning the matched value', (content) => {
    const result = classify({
      relativePath: 'workflows/shared.yaml',
      content: encoder.encode(content),
      bytes: content.length,
      mode: '0644',
      sha256: 'a'.repeat(64),
    });
    expect(result).toMatchObject({ classification: 'blocked', reasonCode: 'SECRET_CONTENT' });
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain('synthetic');
  });
  it.each([
    'path: /Users/example/Developer/project',
    'path: /Volumes/External/Developer/project',
    'path: C:\\\\Users\\\\example\\\\project',
  ])('should block absolute workstation paths without returning them', (content) => {
    const result = classify({
      relativePath: 'config.yaml',
      content: encoder.encode(content),
      bytes: content.length,
      mode: '0644',
      sha256: 'a'.repeat(64),
    });
    expect(result).toMatchObject({ classification: 'blocked', reasonCode: 'ABSOLUTE_PATH_CONTENT' });
    expect(JSON.stringify(result)).not.toContain(content);
    expect(JSON.stringify(result)).not.toContain('/Users/');
    expect(JSON.stringify(result)).not.toContain('/Volumes/');
  });
  it('should block binary NUL content and expose bounded capability evidence', () => {
    const binary = classify({
      relativePath: 'workflows/binary.yaml',
      content: new Uint8Array([65, 0, 66]),
      bytes: 3,
      mode: '0644',
      sha256: 'a'.repeat(64),
    });
    expect(binary).toMatchObject({ classification: 'blocked', reasonCode: 'BINARY_CONTENT' });
    const script = classify({
      relativePath: 'automation/release.sh',
      content: encoder.encode('gh pr create --fill'),
      bytes: 19,
      mode: '0755',
      sha256: 'b'.repeat(64),
    });
    expect(script.detectedCapabilities).toEqual({
      path: 'automation/release.sh',
      capabilities: ['executable', 'github-write', 'external-command'],
    });
  });
});
describe('project template filesystem scan adapter', () => {
  it('should bound reads to inspected size plus one and report concurrent growth', async () => {
    const root = makeRoot();
    const path = join(root, 'growing.yaml');
    writeFileSync(path, '12345');
    const handle = await openFile(path, 'r');
    try {
      const before = await handle.stat();
      appendFileSync(path, '67890');
      const result = await readBoundedProjectTemplateFile(handle, before.size);
      const after = await handle.stat();

      expect(result).toEqual({ status: 'overflow', reasonCode: 'FILE_READ_OVERFLOW' });
      expect(areProjectTemplateFileStatsEqual(before, after)).toBe(false);
    } finally {
      await handle.close();
    }
  });
  it('should scan safe files, distinguish project-owned data, and skip runtime trees', async () => {
    const root = makeRoot();
    write(root, '.takt/config.yaml', 'language: en');
    write(root, '.takt/workflows/shared.yaml', 'name: shared');
    write(root, '.takt/quality-gates/release.yaml', 'command: npm test');
    write(root, '.takt/quality-gates/logs/output.log', 'must not be read');
    write(root, '.takt/notes/unknown.txt', 'api_key=unknown-must-not-be-read');
    write(root, '.devloop/private/secret.txt', 'api_key=must-not-appear');
    chmodSync(join(root, '.takt/quality-gates/logs/output.log'), 0o000);
    chmodSync(join(root, '.takt/notes/unknown.txt'), 0o000);
    chmodSync(join(root, '.devloop/private/secret.txt'), 0o000);
    const result = await scan(root);
    expect(result.scanStatus).toBe('complete');
    expect(result.canExport).toBe(false);
    expect(result.reviewRequired).toBe(true);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'config.yaml', classification: 'project-owned' }),
      expect.objectContaining({ relativePath: 'workflows/shared.yaml', classification: 'portable-candidate' }),
      expect.objectContaining({ relativePath: 'quality-gates/release.yaml', classification: 'project-owned' }),
      expect.objectContaining({ relativePath: 'quality-gates/logs', classification: 'excluded' }),
      expect.objectContaining({ relativePath: '.devloop', classification: 'excluded' }),
    ]));
    expect(result.entries.some((entry) => entry.relativePath.includes('.devloop/'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
    expect(JSON.stringify(result)).not.toContain('unknown-must-not-be-read');
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it('should allow a complete shared-only preview without requiring project review', async () => {
    const root = makeRoot();
    write(root, '.takt/workflows/shared.yaml', 'name: shared');
    write(root, '.takt/facets/reviewer.md', 'Review changes.');
    write(root, '.takt/provider-options/review.yaml', 'claude: {}');

    await expect(scan(root)).resolves.toMatchObject({
      scanStatus: 'complete',
      canExport: true,
      reviewRequired: false,
    });
  });
  it('should fail closed for secret content and never serialize secret, home, or root paths', async () => {
    const root = makeRoot();
    const secret = 'synthetic-secret-never-return';
    write(root, '.takt/workflows/leaky.yaml', `api_key=${secret}\\npath=/Users/example/private`);
    const result = await scan(root);
    expect(result.scanStatus).toBe('blocked');
    expect(result.canExport).toBe(false);
    expect(result.entries[0]).toMatchObject({ classification: 'blocked' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain(root);
  });
  it('should block a repository-specific absolute path without serializing the project root', async () => {
    const root = makeRoot();
    write(root, '.takt/workflows/local.yaml', `cwd: ${root}/source`);

    const result = await scan(root);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'workflows/local.yaml',
        classification: 'blocked',
        reasonCode: 'ABSOLUTE_PATH_CONTENT',
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it('should block root symlinks, child symlinks, and hard-linked files', async () => {
    const linkedProjectRoot = makeRoot();
    const realTaktRoot = makeRoot();
    write(realTaktRoot, 'workflows/shared.yaml', 'safe');
    symlinkSync(realTaktRoot, join(linkedProjectRoot, '.takt'));
    await expect(scan(linkedProjectRoot)).resolves.toMatchObject({
      scanStatus: 'blocked',
      canExport: false,
      entries: [expect.objectContaining({ reasonCode: 'ROOT_SYMLINK' })],
    });
    const root = makeRoot();
    write(root, '.takt/workflows/source.yaml', 'safe');
    symlinkSync('source.yaml', join(root, '.takt/workflows/link.yaml'));
    linkSync(join(root, '.takt/workflows/source.yaml'), join(root, '.takt/workflows/hard.yaml'));
    const result = await scan(root);
    expect(result.scanStatus).toBe('blocked');
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'workflows/link.yaml', reasonCode: 'SYMLINK' }),
      expect.objectContaining({ relativePath: 'workflows/hard.yaml', reasonCode: 'HARD_LINK' }),
    ]));
  });
  it('should block case and NFKC portable-path collisions', async () => {
    const root = makeRoot();
    write(root, '.takt/workflows/K.yaml', 'safe');
    write(root, '.takt/workflows/Ｋ.yaml', 'safe');

    const result = await scan(root);
    expect(result.scanStatus).toBe('blocked');
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'PATH_COLLISION' }),
    ]));
  });
  it('should fail closed on independent node, file, byte, scan, and depth bounds', async () => {
    const root = makeRoot();
    write(root, '.takt/workflows/a.yaml', '12345');
    write(root, '.takt/workflows/b.yaml', '12345');
    write(root, '.takt/workflows/deep/child.yaml', '12345');
    for (const options of [
      { maxNodes: 2 },
      { maxFiles: 1 },
      { maxSingleFileBytes: 4 },
      { maxTotalBytes: 8 },
      { maxScanBytes: 4 },
      { maxDepth: 1 },
    ]) {
      const result = await scan(root, options);
      expect(result.canExport).toBe(false);
      expect(result.scanStatus).not.toBe('complete');
      expect(result.entries.some((entry) => entry.reasonCode.endsWith('LIMIT_EXCEEDED'))).toBe(true);
    }
  });
});
