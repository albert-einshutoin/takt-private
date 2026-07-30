import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
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

    writeRunMetaFileDurably(metaPath, '{"status":"running"}', root, io);

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

    writeRunMetaFileDurably(metaPath, '{"status":"running"}', root, io);
    phases.length = 0;
    writeRunMetaFileDurably(metaPath, '{"currentStep":"review"}', root, io);
    writeRunMetaFileDurably(metaPath, '{"status":"completed"}', root, io);

    expect(phases.filter((phase) => [
      'directory-fsync',
      'open-temp',
      'write',
      'file-fsync',
      'close',
      'rename',
    ].includes(phase))).toEqual([
      'directory-fsync',
      'directory-fsync',
      'directory-fsync',
      'open-temp',
      'write',
      'file-fsync',
      'close',
      'rename',
      'directory-fsync',
      'directory-fsync',
      'directory-fsync',
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
    writeRunMetaFileDurably(metaPath, '{"status":"running"}', root, io);
    armFault = true;

    expect(() => writeRunMetaFileDurably(
      metaPath,
      '{"status":"completed"}',
      root,
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

    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io))
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

    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io)).not.toThrow();
    expect(directoryFsyncAttempts).toEqual([]);
    expect(readFileSync(metaPath, 'utf8')).toBe('{}');
  });

  it('rejects path escape and a symlink anywhere below the trusted root', () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(root, '.takt'), { mode: 0o700 });
    symlinkSync(outside, join(root, '.takt', 'runs'));

    expect(() => writeRunMetaFileDurably(
      join(root, '..', 'escaped', 'meta.json'),
      '{}',
      root,
    )).toThrow('outside trusted project root');
    expect(() => writeRunMetaFileDurably(
      join(root, '.takt', 'runs', 'run-1', 'meta.json'),
      '{}',
      root,
    )).toThrow('directory chain is unsafe');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('revalidates the full chain after closing the temp and before rename', () => {
    const root = makeRoot();
    const outside = makeRoot();
    const runRoot = join(root, '.takt', 'runs', 'run-1');
    const displaced = join(root, 'displaced-run');
    const metaPath = join(runRoot, 'meta.json');
    let tempClosed = false;
    let swapped = false;
    const io = createRunMetaStorageIo({
      before(operation, path) {
        if (operation === 'close') tempClosed = true;
        if (
          tempClosed
          && !swapped
          && operation === 'lstat'
          && path === root
        ) {
          renameSync(runRoot, displaced);
          symlinkSync(outside, runRoot);
          swapped = true;
        }
      },
    });

    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io))
      .toThrow('directory chain is unsafe');
    expect(existsSync(join(outside, 'meta.json'))).toBe(false);
  });

  it('does not rename or unlink when a directory is replaced with another directory', () => {
    const root = makeRoot();
    const runRoot = join(root, '.takt', 'runs', 'run-1');
    const displaced = join(root, 'displaced-run');
    const metaPath = join(runRoot, 'meta.json');
    let tempClosed = false;
    let replaced = false;
    const publicationOperations: RunMetaStorageOperation[] = [];
    const io = createRunMetaStorageIo({
      before(operation, path) {
        if (operation === 'close') tempClosed = true;
        if (
          tempClosed
          && !replaced
          && operation === 'lstat'
          && path === root
        ) {
          renameSync(runRoot, displaced);
          mkdirSync(runRoot, { mode: 0o700 });
          replaced = true;
        }
        if (replaced && (operation === 'rename' || operation === 'unlink')) {
          publicationOperations.push(operation);
        }
      },
    });

    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io))
      .toThrow('directory chain identity changed');
    expect(publicationOperations).toEqual([]);
    expect(existsSync(metaPath)).toBe(false);
  });

  it('re-fsyncs an existing directory chain after a prior publication failure', () => {
    const root = makeRoot();
    const metaPath = join(root, '.takt', 'runs', 'run-1', 'meta.json');
    let failOnce = true;
    const fsynced: string[] = [];
    const io = createRunMetaStorageIo({
      before(operation, path) {
        if (operation !== 'directory-fsync') return;
        fsynced.push(path);
        if (failOnce && path === root) {
          failOnce = false;
          throw new Error('injected first parent fsync failure');
        }
      },
    });

    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io))
      .toThrow('injected first parent fsync failure');
    fsynced.length = 0;
    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io)).not.toThrow();
    expect(fsynced.slice(0, 3)).toEqual([
      root,
      join(root, '.takt'),
      join(root, '.takt', 'runs'),
    ]);
  });

  it('fsyncs the parent after an EEXIST mkdir race', () => {
    const root = makeRoot();
    const taktRoot = join(root, '.takt');
    mkdirSync(taktRoot, { mode: 0o700 });
    const metaPath = join(taktRoot, 'runs', 'run-1', 'meta.json');
    const baseIo = createRunMetaStorageIo();
    let hideTaktOnce = true;
    const fsynced: string[] = [];
    const io = {
      ...baseIo,
      lstat(path: string) {
        if (path === taktRoot && hideTaktOnce) {
          hideTaktOnce = false;
          return undefined;
        }
        return baseIo.lstat(path);
      },
      fsyncDirectory(path: string) {
        fsynced.push(path);
        baseIo.fsyncDirectory(path);
      },
    };

    expect(() => writeRunMetaFileDurably(metaPath, '{}', root, io)).not.toThrow();
    expect(fsynced[0]).toBe(root);
  });
});
