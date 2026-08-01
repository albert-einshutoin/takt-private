import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/copy-build-assets.mjs', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('copy-build-assets', () => {
  it('copies the fixed runtime allowlist without shell or wildcard semantics', () => {
    const root = fixture();
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });

    expect(result).toMatchObject({ status: 0 });
    expect(readFileSync(join(root, 'dist/shared/prompts/en/a.md'), 'utf8')).toBe('en');
    expect(readFileSync(join(root, 'dist/shared/prompts/ja/b.md'), 'utf8')).toBe('ja');
    expect(readFileSync(join(root, 'dist/shared/i18n/labels_en.yaml'), 'utf8')).toBe('en-label');
    expect(readFileSync(join(root, 'dist/shared/i18n/labels_ja.yaml'), 'utf8')).toBe('ja-label');
    expect(readFileSync(join(root, 'dist/core/runtime/presets/a.sh'), 'utf8')).toBe('preset');
    expect(existsSync(join(root, 'dist/shared/prompts/en/ignored.txt'))).toBe(false);
    expect(existsSync(join(root, 'dist/core/runtime/presets/ignored.md'))).toBe(false);
  });

  it('fails when a required source directory or fixed label file is missing', () => {
    const root = fixture();
    rmSync(join(root, 'src/shared/i18n/labels_ja.yaml'));

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, 'dist/shared/i18n/labels_ja.yaml'))).toBe(false);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-copy-build-assets-'));
  roots.push(root);
  write(root, 'src/shared/prompts/en/a.md', 'en');
  write(root, 'src/shared/prompts/en/ignored.txt', 'ignored');
  write(root, 'src/shared/prompts/ja/b.md', 'ja');
  write(root, 'src/shared/i18n/labels_en.yaml', 'en-label');
  write(root, 'src/shared/i18n/labels_ja.yaml', 'ja-label');
  write(root, 'src/core/runtime/presets/a.sh', 'preset');
  write(root, 'src/core/runtime/presets/ignored.md', 'ignored');
  return root;
}

function write(root: string, relativePath: string, bytes: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
