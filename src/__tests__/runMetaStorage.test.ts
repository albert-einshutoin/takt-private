import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRunMetaStorageIo,
  writeRunMetaFileDurably,
  type RunMetaStorageOperation,
} from '../features/tasks/execute/runMetaStorage.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-run-meta-storage-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('run meta durable storage', () => {
  it('creates the run directory chain durably with private modes', () => {
    const root = makeRoot();
    const metaPath = join(root, '.takt', 'runs', 'run-1', 'meta.json');
    const events: Array<[RunMetaStorageOperation, string]> = [];
    const io = createRunMetaStorageIo({
      before: (operation, path) => events.push([operation, path]),
    });

    writeRunMetaFileDurably(metaPath, '{"status":"running"}', io);

    const taktRoot = join(root, '.takt');
    const runsRoot = join(taktRoot, 'runs');
    const runRoot = dirname(metaPath);
    expect(events.filter(([operation]) =>
      operation === 'mkdir' || operation === 'directory-fsync')).toEqual([
      ['mkdir', taktRoot],
      ['directory-fsync', root],
      ['mkdir', runsRoot],
      ['directory-fsync', taktRoot],
      ['mkdir', runRoot],
      ['directory-fsync', runsRoot],
      ['directory-fsync', runRoot],
    ]);
    expect(lstatSync(taktRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(runsRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(runRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(metaPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(metaPath, 'utf8')).toBe('{"status":"running"}');
  });

  it('uses file fsync, rename, and parent fsync for every replacement', () => {
    const root = makeRoot();
    const metaPath = join(root, '.takt', 'runs', 'run-1', 'meta.json');
    const phases: RunMetaStorageOperation[] = [];
    const io = createRunMetaStorageIo({
      before: (operation) => phases.push(operation),
    });

    writeRunMetaFileDurably(metaPath, '{"status":"running"}', io);
    phases.length = 0;
    writeRunMetaFileDurably(metaPath, '{"currentStep":"review"}', io);
    writeRunMetaFileDurably(metaPath, '{"status":"completed"}', io);

    expect(phases.filter((phase) => [
      'open-temp',
      'write',
      'file-fsync',
      'close',
      'rename',
      'directory-fsync',
    ].includes(phase))).toEqual([
      'open-temp',
      'write',
      'file-fsync',
      'close',
      'rename',
      'directory-fsync',
      'open-temp',
      'write',
      'file-fsync',
      'close',
      'rename',
      'directory-fsync',
    ]);
    expect(readFileSync(metaPath, 'utf8')).toBe('{"status":"completed"}');
  });

  it.each([
    ['file-fsync' as const, false],
    ['rename' as const, false],
    ['directory-fsync' as const, true],
  ])('fails closed at %s with cleanup only before rename', (faultOperation, published) => {
    const root = makeRoot();
    const metaPath = join(root, '.takt', 'runs', 'run-1', 'meta.json');
    let armFault = false;
    const unlinked: string[] = [];
    const io = createRunMetaStorageIo({
      before: (operation, path) => {
        if (armFault && operation === 'unlink') unlinked.push(path);
        if (
          armFault
          && operation === faultOperation
          && (
            operation !== 'directory-fsync'
            || path === dirname(metaPath)
          )
        ) {
          throw new Error(`injected ${operation}`);
        }
      },
    });
    writeRunMetaFileDurably(metaPath, '{"status":"running"}', io);
    armFault = true;

    expect(() => writeRunMetaFileDurably(
      metaPath,
      '{"status":"completed"}',
      io,
    )).toThrow(`injected ${faultOperation}`);
    expect(readFileSync(metaPath, 'utf8')).toBe(
      published ? '{"status":"completed"}' : '{"status":"running"}',
    );
    expect(readdirSync(dirname(metaPath)).filter((name) => name.endsWith('.tmp')))
      .toEqual([]);
    expect(unlinked).toHaveLength(published ? 0 : 1);
  });

  it('does not continue the directory chain after mkdir publication fails', () => {
    const root = makeRoot();
    const taktRoot = join(root, '.takt');
    const metaPath = join(taktRoot, 'runs', 'run-1', 'meta.json');
    const io = createRunMetaStorageIo({
      before: (operation, path) => {
        if (operation === 'directory-fsync' && path === root) {
          throw new Error('injected mkdir publication failure');
        }
      },
    });

    expect(() => writeRunMetaFileDurably(metaPath, '{}', io))
      .toThrow('injected mkdir publication failure');
    expect(existsSync(taktRoot)).toBe(true);
    expect(existsSync(join(taktRoot, 'runs'))).toBe(false);
  });

  it('treats only directory fsync as best-effort on Windows', () => {
    const root = makeRoot();
    const metaPath = join(root, '.takt', 'runs', 'run-1', 'meta.json');
    const directoryFsyncAttempts: string[] = [];
    const io = createRunMetaStorageIo({
      before: (operation, path) => {
        if (operation === 'directory-fsync') {
          directoryFsyncAttempts.push(path);
          throw new Error('unsupported directory fsync');
        }
      },
    }, 'win32');

    expect(() => writeRunMetaFileDurably(metaPath, '{}', io)).not.toThrow();
    expect(directoryFsyncAttempts).toEqual([]);
    expect(readFileSync(metaPath, 'utf8')).toBe('{}');
  });
});
