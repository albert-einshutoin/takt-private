import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProjectTemplateExportPlan,
  writeTaktpack,
} from '../../features/project-template/index.js';
import {
  GithubTemplateDownloadStorageError,
  materializeGithubTemplateCache,
  reclaimGithubTemplateCacheTemps,
  stageGithubTemplateDownload,
  verifyGithubTemplateDownloadStaging,
} from '../../features/project-template/github-download-storage.js';

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function prepareControlRoot(projectRoot: string): string {
  const controlRoot = join(projectRoot, '.takt-template-state');
  mkdirSync(controlRoot, { mode: 0o700 });
  return controlRoot;
}

async function makePack(root: string): Promise<Buffer> {
  const sourcePath = join(root, '.takt', 'workflows', 'review.yaml');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, 'name: review\n');
  const plan = await createProjectTemplateExportPlan(root, {
    packVersion: '1.0.0',
    takt: { minVersion: '0.48.0' },
    source: {
      kind: 'local',
      uri: '.',
      ref: 'workspace',
      commit: 'a'.repeat(40),
    },
  });
  const path = join(root, 'source.taktpack');
  await writeTaktpack(path, plan);
  return readFileSync(path);
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function* chunks(...values: unknown[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value as Uint8Array;
}

async function stagePack(projectRoot: string) {
  prepareControlRoot(projectRoot);
  const content = await makePack(projectRoot);
  const staged = await stageGithubTemplateDownload({
    projectRoot,
    expectedBytes: content.byteLength,
    expectedSha256: sha256(content),
    chunks: chunks(content),
  });
  return { content, staged };
}

function prepareCacheRoot(): string {
  const cacheRoot = makeRoot('takt-github-cache-');
  chmodSync(cacheRoot, 0o700);
  return realpathSync.native(cacheRoot);
}

function writeExistingCache(
  cacheRoot: string,
  content: Uint8Array,
): string {
  const shaRoot = join(cacheRoot, 'sha256');
  mkdirSync(shaRoot, { mode: 0o700 });
  const path = join(shaRoot, `${sha256(content)}.taktpack`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

function cacheTempPath(
  cacheRoot: string,
  pid: number,
  sha: string,
  uuid = '123e4567-e89b-42d3-a456-426614174000',
): string {
  return join(cacheRoot, 'sha256', `.tmp.${pid}.${uuid}.${sha}`);
}

function deadProcessProbe(
  pid: number,
): 'alive' | 'missing' | 'inaccessible' {
  return pid === process.pid ? 'alive' : 'missing';
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GitHub template download staging', () => {
  it('streams, fsyncs, hashes, and semantically validates private ingress', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const content = await makePack(projectRoot);

    const result = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: content.byteLength,
      expectedSha256: sha256(content),
      chunks: chunks(
        content.subarray(0, 31),
        new Uint8Array(),
        content.subarray(31),
      ),
    });

    expect(result).toMatchObject({
      bytes: content.byteLength,
      sha256: sha256(content),
    });
    expect(result.stagingPath).toMatch(
      /\.takt-template-state\/download-staging\/[0-9a-f-]{36}\/asset\.partial$/,
    );
    expect(readFileSync(result.stagingPath)).toEqual(content);
    expect(lstatSync(result.stagingPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(dirname(result.stagingPath)).mode & 0o777).toBe(0o700);
    expect(result.inspection.archiveSha256).toBe(sha256(content));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.inspection)).toBe(true);
    expect(Object.isFrozen(result.inspection.manifest)).toBe(true);
    expect(Object.isFrozen(result.inspection.manifest.entries)).toBe(true);
    expect(Object.isFrozen(result.inspection.manifest.entries[0])).toBe(true);
  });

  it.each([
    ['zero bytes', 0, 'a'.repeat(64)],
    ['over 40 MiB', 40 * 1024 * 1024 + 1, 'a'.repeat(64)],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1, 'a'.repeat(64)],
    ['uppercase hash', 1, 'A'.repeat(64)],
    ['short hash', 1, 'a'.repeat(63)],
  ])('rejects invalid options: %s', async (_label, expectedBytes, expectedSha256) => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes,
      expectedSha256,
      chunks: chunks(new Uint8Array([1])),
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects oversize, undersize, and hash mismatch and removes own staging', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    const controlRoot = prepareControlRoot(projectRoot);
    const cases = [
      {
        expectedBytes: 1,
        expectedSha256: sha256(new Uint8Array([1])),
        chunks: chunks(new Uint8Array([1, 2])),
        code: 'LIMIT_EXCEEDED',
      },
      {
        expectedBytes: 2,
        expectedSha256: sha256(new Uint8Array([1, 2])),
        chunks: chunks(new Uint8Array([1])),
        code: 'SIZE_MISMATCH',
      },
      {
        expectedBytes: 1,
        expectedSha256: 'b'.repeat(64),
        chunks: chunks(new Uint8Array([1])),
        code: 'HASH_MISMATCH',
      },
    ];
    for (const testCase of cases) {
      const { code, ...stageOptions } = testCase;
      await expect(stageGithubTemplateDownload({
        projectRoot,
        ...stageOptions,
      })).rejects.toMatchObject({ code });
    }
    const stagingRoot = join(controlRoot, 'download-staging');
    expect(existsSync(stagingRoot) ? readdirSync(stagingRoot) : []).toEqual([]);
  });

  it('rejects non-Uint8Array chunks while ignoring zero-byte chunks', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array(), 'not bytes'),
    })).rejects.toMatchObject({ code: 'INVALID_CHUNK' });
  });

  it('honors AbortSignal before and during streaming', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const before = new AbortController();
    before.abort();
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array([1])),
      signal: before.signal,
    })).rejects.toMatchObject({ code: 'ABORTED' });

    const during = new AbortController();
    async function* aborting(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array();
      during.abort();
      yield new Uint8Array([1]);
    }
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: aborting(),
      signal: during.signal,
    })).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('redacts stream and semantic inspection failures', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    async function* failing(): AsyncGenerator<Uint8Array> {
      throw new Error('token=ghp_stream_secret');
    }
    const streamError = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: failing(),
    }).catch((error: unknown) => error);
    expect(streamError).toMatchObject({ code: 'STREAM_FAILED' });
    expect(String((streamError as Error).message)).not.toContain('ghp_stream_secret');

    const invalid = Buffer.from('not a taktpack');
    const inspectError = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: invalid.byteLength,
      expectedSha256: sha256(invalid),
      chunks: chunks(invalid),
    }).catch((error: unknown) => error);
    expect(inspectError).toMatchObject({ code: 'INSPECTION_FAILED' });
    expect(inspectError).toBeInstanceOf(GithubTemplateDownloadStorageError);
  });

  it.each(['symlink', 'broad-mode'] as const)(
    'fails closed for unsafe download-staging %s',
    async (kind) => {
      const projectRoot = makeRoot('takt-github-download-');
      const controlRoot = prepareControlRoot(projectRoot);
      const stagingRoot = join(controlRoot, 'download-staging');
      if (kind === 'symlink') {
        const target = makeRoot('takt-github-download-target-');
        symlinkSync(target, stagingRoot);
      } else {
        mkdirSync(stagingRoot, { mode: 0o700 });
        chmodSync(stagingRoot, 0o755);
      }
      await expect(stageGithubTemplateDownload({
        projectRoot,
        expectedBytes: 1,
        expectedSha256: 'a'.repeat(64),
        chunks: chunks(new Uint8Array([1])),
      })).rejects.toMatchObject({ code: 'UNSAFE_STAGING' });
    },
  );

  it('preserves the primary error when best-effort cleanup also fails', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const error = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'b'.repeat(64),
      chunks: chunks(new Uint8Array([1])),
      ioSeam: {
        onPhase(phase) {
          if (phase === 'before-cleanup') {
            throw new Error('cleanup secret');
          }
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'HASH_MISMATCH' });
    expect(String((error as Error).message)).not.toContain('cleanup secret');
  });

  it('normalizes option and iterator traps without trusting forged errors', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const getterOptions = {
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array([1])),
    } as Record<string, unknown>;
    Object.defineProperty(getterOptions, 'projectRoot', {
      enumerable: true,
      get() {
        throw new Error('ghp_option_secret');
      },
    });
    const optionError = await stageGithubTemplateDownload(
      getterOptions as never,
    ).catch((error: unknown) => error);
    expect(optionError).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((optionError as Error).message)).not.toContain(
      'ghp_option_secret',
    );
    const proxyError = await stageGithubTemplateDownload(new Proxy({}, {
      ownKeys() {
        throw new Error('ghp_option_proxy_secret');
      },
    }) as never).catch((error: unknown) => error);
    expect(proxyError).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((proxyError as Error).message)).not.toContain(
      'ghp_option_proxy_secret',
    );

    const forged = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new GithubTemplateDownloadStorageError(
              'HASH_MISMATCH',
              'ghp_forged_stream_secret',
            );
          },
        };
      },
    };
    const streamError = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: forged,
    }).catch((error: unknown) => error);
    expect(streamError).toMatchObject({ code: 'STREAM_FAILED' });
    expect(String((streamError as Error).message)).not.toContain(
      'ghp_forged_stream_secret',
    );

    const trappedResult = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Proxy({}, {
              get() {
                throw new Error('ghp_iterator_result_secret');
              },
            });
          },
        };
      },
    };
    const resultError = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: trappedResult as AsyncIterable<Uint8Array>,
    }).catch((error: unknown) => error);
    expect(resultError).toMatchObject({ code: 'STREAM_FAILED' });
    expect(String((resultError as Error).message)).not.toContain(
      'ghp_iterator_result_secret',
    );
  });

  it('fails boundedly when a write makes no progress', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array([1])),
      ioSeam: {
        write() {
          return 0;
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });
  });

  it('re-syncs an existing staging root after parent fsync failure', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const content = await makePack(projectRoot);
    let failed = false;
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: content.byteLength,
      expectedSha256: sha256(content),
      chunks: chunks(content),
      ioSeam: {
        onPhase(phase) {
          if (phase === 'before-staging-root-parent-fsync' && !failed) {
            failed = true;
            throw new Error('injected parent fsync failure');
          }
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });

    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: content.byteLength,
      expectedSha256: sha256(content),
      chunks: chunks(content),
    })).resolves.toMatchObject({ sha256: sha256(content) });
  });

  it('snapshots real typed-array chunks and redacts Proxy chunk traps', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const original = new Uint8Array([1]);
    let observedSnapshot: Uint8Array | undefined;
    const staged = stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: sha256(original),
      chunks: chunks(original),
      ioSeam: {
        write(fd, snapshot, offset, length, position) {
          observedSnapshot = snapshot;
          original[0] = 2;
          return writeSync(fd, snapshot, offset, length, position);
        },
      },
    });
    await expect(staged).rejects.toMatchObject({ code: 'INSPECTION_FAILED' });
    expect(observedSnapshot).not.toBe(original);
    expect(observedSnapshot).toEqual(new Uint8Array([1]));

    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(1));
      shared[0] = 3;
      let observedSharedSnapshot: Uint8Array | undefined;
      await expect(stageGithubTemplateDownload({
        projectRoot,
        expectedBytes: 1,
        expectedSha256: sha256(shared),
        chunks: chunks(shared),
        ioSeam: {
          write(fd, snapshot, offset, length, position) {
            observedSharedSnapshot = snapshot;
            shared[0] = 4;
            return writeSync(fd, snapshot, offset, length, position);
          },
        },
      })).rejects.toMatchObject({ code: 'INSPECTION_FAILED' });
      expect(observedSharedSnapshot?.buffer).not.toBe(shared.buffer);
      expect(observedSharedSnapshot).toEqual(new Uint8Array([3]));
    }

    const forged = new GithubTemplateDownloadStorageError(
      'HASH_MISMATCH',
      'ghp_chunk_proxy_secret',
    );
    const proxy = new Proxy(new Uint8Array([1]), {
      get() {
        throw forged;
      },
    });
    const proxyChunks = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (delivered) return { done: true as const, value: undefined };
            delivered = true;
            return { done: false as const, value: proxy };
          },
        };
      },
    };
    const proxyError = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: proxyChunks,
    }).catch((error: unknown) => error);
    expect(proxyError).toMatchObject({ code: 'INVALID_CHUNK' });
    expect(String((proxyError as Error).message)).not.toContain(
      'ghp_chunk_proxy_secret',
    );
  });

  it('best-effort closes an unfinished iterator without replacing primary errors', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    let returns = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: 'invalid chunk' };
          },
          async return() {
            returns += 1;
            throw new GithubTemplateDownloadStorageError(
              'HASH_MISMATCH',
              'ghp_iterator_return_secret',
            );
          },
        };
      },
    };
    const error = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: iterable as AsyncIterable<Uint8Array>,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_CHUNK' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_iterator_return_secret',
    );
    expect(returns).toBe(1);
  });

  it('aborts a pending next without waiting for a pending iterator return', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const controller = new AbortController();
    let returns = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
          return() {
            returns += 1;
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          },
        };
      },
    };
    const staged = stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: iterable,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 0);

    await expect(Promise.race([
      staged,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('abort timeout')), 500);
      }),
    ])).rejects.toMatchObject({ code: 'ABORTED' });
    expect(returns).toBe(1);
  });

  it('does not observe IteratorResult.value after done is true', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Proxy({ done: true }, {
              get(target, property, receiver) {
                if (property === 'value') {
                  throw new Error('ghp_done_value_secret');
                }
                return Reflect.get(target, property, receiver);
              },
            });
          },
        };
      },
    };
    const error = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: iterable as AsyncIterable<Uint8Array>,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_done_value_secret',
    );
  });

  it('removes the abort listener after next settles', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener() {
        added += 1;
      },
      removeEventListener() {
        removed += 1;
      },
    } as unknown as AbortSignal;
    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(),
      signal,
    })).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect({ added, removed }).toEqual({ added: 1, removed: 1 });
  });

  it('does not start iterator work when abort fires during listener setup', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    let nextCalls = 0;
    let returnCalls = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            return { done: true as const, value: undefined };
          },
          async return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === 'function') {
          listener(new Event('abort'));
        } else {
          listener.handleEvent(new Event('abort'));
        }
      },
      removeEventListener() {},
    } as unknown as AbortSignal;

    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: iterable,
      signal,
    })).rejects.toMatchObject({ code: 'ABORTED' });
    expect({ nextCalls, returnCalls }).toEqual({ nextCalls: 0, returnCalls: 1 });
  });

  it.each([0.5, 2, Number.NaN])(
    'rejects invalid write progress %s',
    async (written) => {
      const projectRoot = makeRoot('takt-github-download-');
      prepareControlRoot(projectRoot);
      await expect(stageGithubTemplateDownload({
        projectRoot,
        expectedBytes: 1,
        expectedSha256: 'a'.repeat(64),
        chunks: chunks(new Uint8Array([1])),
        ioSeam: {
          write() {
            return written;
          },
        },
      })).rejects.toMatchObject({ code: 'IO_FAILURE' });
    },
  );

  it('normalizes forged io seam errors', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    prepareControlRoot(projectRoot);
    const error = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array([1])),
      ioSeam: {
        onPhase(phase) {
          if (phase === 'ingress-created') {
            throw new GithubTemplateDownloadStorageError(
              'HASH_MISMATCH',
              'ghp_io_seam_secret',
            );
          }
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'IO_FAILURE' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_io_seam_secret',
    );

    const authentic = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 0,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array()),
    }).catch((caught: unknown) => caught) as GithubTemplateDownloadStorageError;
    expect(Object.isFrozen(authentic)).toBe(true);
    expect(() => Object.defineProperty(authentic, 'code', {
      value: 'HASH_MISMATCH',
    })).toThrow();
    const reinjected = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: 1,
      expectedSha256: 'a'.repeat(64),
      chunks: chunks(new Uint8Array([1])),
      ioSeam: {
        onPhase(phase) {
          if (phase === 'ingress-created') throw authentic;
        },
      },
    }).catch((caught: unknown) => caught);
    expect(reinjected).toMatchObject({ code: 'IO_FAILURE' });
  });
});

describe('GitHub template staged authority verification', () => {
  it('accepts only the original module-sealed result and deeply freezes verification', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    const { staged } = await stagePack(projectRoot);

    const verified = await verifyGithubTemplateDownloadStaging(staged);

    expect(verified).toBe(staged);
    expect(verified).toMatchObject({
      stagingPath: staged.stagingPath,
      bytes: staged.bytes,
      sha256: staged.sha256,
    });
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.inspection)).toBe(true);
    await expect(verifyGithubTemplateDownloadStaging({
      ...verified,
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    await expect(verifyGithubTemplateDownloadStaging(Object.freeze({
      stagingPath: verified.stagingPath,
      bytes: verified.bytes,
      sha256: verified.sha256,
      inspection: verified.inspection,
    }))).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it.each([
    ['mode', (path: string) => chmodSync(path, 0o644)],
    ['size', (path: string) => writeFileSync(path, 'tampered')],
    ['hardlink', (path: string) => linkSync(path, `${path}.alias`)],
  ])('rejects staged file %s tampering', async (_label, tamper) => {
    const projectRoot = makeRoot('takt-github-download-');
    const { staged } = await stagePack(projectRoot);
    tamper(staged.stagingPath);

    await expect(
      verifyGithubTemplateDownloadStaging(staged),
    ).rejects.toMatchObject({ code: 'UNSAFE_STAGING' });
  });

  it('rehashes the full staged file and redacts tampered content', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    const { content, staged } = await stagePack(projectRoot);
    const tampered = Buffer.from(content);
    tampered[tampered.byteLength - 1] ^= 1;
    writeFileSync(staged.stagingPath, tampered);

    const error = await verifyGithubTemplateDownloadStaging(staged).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'HASH_MISMATCH' });
    expect(String((error as Error).message)).not.toContain(
      tampered.subarray(-16).toString('hex'),
    );
  });

  it('does not follow a staged path replaced after sealing', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    const { staged } = await stagePack(projectRoot);
    const external = join(makeRoot('takt-external-'), 'secret');
    writeFileSync(external, 'ghp_staging_symlink_secret');
    unlinkSync(staged.stagingPath);
    symlinkSync(external, staged.stagingPath);

    const error = await verifyGithubTemplateDownloadStaging(staged).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'UNSAFE_STAGING' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_staging_symlink_secret',
    );
    expect(lstatSync(staged.stagingPath).isSymbolicLink()).toBe(true);
  });

  it('re-inspects after hashing and detects same-inode TOCTOU tampering', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    let armed = false;
    let reinspections = 0;
    prepareControlRoot(projectRoot);
    const content = await makePack(projectRoot);
    const staged = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: content.byteLength,
      expectedSha256: sha256(content),
      chunks: chunks(content),
      ioSeam: {
        onPhase(phase, path) {
          if (armed && phase === 'before-staging-reinspect') {
            reinspections += 1;
            writeFileSync(path, Buffer.alloc(content.byteLength));
          }
        },
      },
    });
    armed = true;

    await expect(
      verifyGithubTemplateDownloadStaging(staged),
    ).rejects.toMatchObject({ code: 'INSPECTION_FAILED' });
    expect(reinspections).toBe(1);
  });

  it('does not return success when verified descriptor close fails', async () => {
    const projectRoot = makeRoot('takt-github-download-');
    let armed = false;
    prepareControlRoot(projectRoot);
    const content = await makePack(projectRoot);
    const staged = await stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: content.byteLength,
      expectedSha256: sha256(content),
      chunks: chunks(content),
      ioSeam: {
        onPhase(phase) {
          if (armed && phase === 'before-staging-verify-close') {
            throw new Error('ghp_verify_close_secret');
          }
        },
      },
    });
    armed = true;

    const error = await verifyGithubTemplateDownloadStaging(staged).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'IO_FAILURE' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_verify_close_secret',
    );
  });
});

describe('GitHub template existing global cache materialization', () => {
  it('claims, strictly verifies a cache hit, and consumes staging', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    const cachePath = writeExistingCache(cacheRoot, content);

    const cached = await materializeGithubTemplateCache({ staged, cacheRoot });

    expect(cached).toMatchObject({
      cachePath: realpathSync.native(cachePath),
      bytes: content.byteLength,
      sha256: sha256(content),
      status: 'cache-hit',
      artifactState: 'cache-published',
    });
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached.inspection)).toBe(true);
    expect(existsSync(staged.stagingPath)).toBe(false);
    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
  });

  it('claims synchronously and publishes a stable cache miss', async () => {
    const cacheRoot = prepareCacheRoot();
    const { staged } = await stagePack(makeRoot('takt-github-download-'));

    const first = materializeGithubTemplateCache({ staged, cacheRoot });
    const second = materializeGithubTemplateCache({ staged, cacheRoot });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const failure = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    expect(failure?.reason).toMatchObject({ code: 'INVALID_AUTHORITY' });
    const success = settled.find(
      (entry): entry is PromiseFulfilledResult<
        Awaited<ReturnType<typeof materializeGithubTemplateCache>>
      > => entry.status === 'fulfilled',
    );
    expect(success?.value).toMatchObject({ status: 'cache-published' });
    expect(existsSync(staged.stagingPath)).toBe(false);
  });

  it('supports partial cache writes and leaves no private temp', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );

    let tempPath = '';
    const cached = await materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase, path) {
          if (phase === 'before-cache-temp-fsync') tempPath = path;
        },
        cacheWrite(fd, chunk, offset, length, position) {
          const partial = Math.max(1, Math.floor(length / 2));
          return writeSync(fd, chunk, offset, partial, position);
        },
      },
    });

    expect(cached.status).toBe('cache-published');
    expect(tempPath).toMatch(
      /\/\.tmp\.\d+\.[0-9a-f-]{36}\.[a-f0-9]{64}$/,
    );
    expect(readFileSync(cached.cachePath)).toEqual(content);
    expect(
      readdirSync(join(cacheRoot, 'sha256')).filter(
        (entry) => entry.startsWith('.tmp.'),
      ),
    ).toEqual([]);
  });

  it.each(['read', 'write'] as const)(
    'rejects zero-progress cache %s and cleans owned temp',
    async (operation) => {
      const cacheRoot = prepareCacheRoot();
      const { staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );

      await expect(materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: operation === 'read'
          ? { cacheRead: () => 0 }
          : { cacheWrite: () => 0 },
      })).rejects.toMatchObject({ code: 'IO_FAILURE' });
      expect(readdirSync(join(cacheRoot, 'sha256'))).toEqual([]);
    },
  );

  it.each(['fsync', 'link', 'unlink'] as const)(
    'redacts native cache %s seam failure',
    async (operation) => {
      const cacheRoot = prepareCacheRoot();
      const { staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const fault = () => {
        throw new Error('ghp_native_publish_secret');
      };
      const error = await materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: operation === 'fsync'
          ? { cacheFsync: fault }
          : operation === 'link'
            ? { cacheLink: fault }
            : { cacheUnlink: fault },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'IO_FAILURE' });
      expect(String((error as Error).message)).not.toContain(
        'ghp_native_publish_secret',
      );
    },
  );

  it.each(['temporary', 'final', 'directory'] as const)(
    'fails closed for cache %s descriptor close fault',
    async (kind) => {
      const cacheRoot = prepareCacheRoot();
      const { staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const error = await materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: {
          cacheClose(_fd, descriptorKind) {
            if (descriptorKind === kind) {
              throw new Error('ghp_cache_close_secret');
            }
          },
        },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'IO_FAILURE',
        artifactState: 'cache-published',
      });
      expect(String((error as Error).message)).not.toContain(
        'ghp_cache_close_secret',
      );
    },
  );

  it('treats an EEXIST link winner as a strictly verified cache hit', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );

    const result = await materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase, path) {
          if (phase === 'before-cache-link') {
            writeFileSync(
              join(dirname(path), `${sha256(content)}.taktpack`),
              content,
              { mode: 0o600 },
            );
          }
        },
      },
    });

    expect(result.status).toBe('cache-hit');
  });

  it('never overwrites an invalid EEXIST link winner', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    let winnerPath = '';

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase, path) {
          if (phase === 'before-cache-link') {
            winnerPath = join(
              dirname(path),
              `${sha256(content)}.taktpack`,
            );
            writeFileSync(winnerPath, Buffer.alloc(content.byteLength), {
              mode: 0o600,
            });
          }
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    expect(readFileSync(winnerPath)).toEqual(
      Buffer.alloc(content.byteLength),
    );
  });

  it('detects staging mutation between retained-FD verification and copy', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    let firstRead = true;

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        cacheRead(fd, buffer, offset, length, position) {
          if (firstRead) {
            firstRead = false;
            writeFileSync(
              staged.stagingPath,
              Buffer.alloc(content.byteLength),
            );
          }
          return readSync(fd, buffer, offset, length, position);
        },
      },
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  });

  it('revalidates and detects final tampering after own link publication', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase, path) {
          if (phase === 'before-cache-final-inspect') {
            writeFileSync(path, Buffer.alloc(content.byteLength), {
              mode: 0o600,
            });
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'CACHE_INVALID',
      artifactState: 'cache-published',
    });
  });

  it.each([
    ['before-cache-temp-fsync', 'none'],
    ['before-cache-link', 'none'],
    ['before-cache-temp-unlink', 'cache-published'],
    ['before-cache-publish-parent-fsync', 'cache-published'],
    ['before-cache-temp-unlink-parent-fsync', 'cache-published'],
  ] as const)(
    'fails closed for cache publication fault at %s',
    async (faultPhase, artifactState) => {
      const cacheRoot = prepareCacheRoot();
      const { staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const error = await materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: {
          onCachePhase(phase) {
            if (phase === faultPhase) {
              throw new Error('ghp_publish_fault_secret');
            }
          },
        },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'IO_FAILURE', artifactState });
      expect(String((error as Error).message)).not.toContain(
        'ghp_publish_fault_secret',
      );
    },
  );

  it('rejects clone and forge without consuming the original', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    writeExistingCache(cacheRoot, content);

    await expect(materializeGithubTemplateCache({
      staged: { ...staged },
      cacheRoot,
    })).rejects.toMatchObject({ code: 'INVALID_AUTHORITY' });
    expect(existsSync(staged.stagingPath)).toBe(true);
    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
    })).resolves.toMatchObject({ status: 'cache-hit' });
  });

  it('does not consume authority for invalid optional fields', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    writeExistingCache(cacheRoot, content);

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot: 1 as unknown as string,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(existsSync(staged.stagingPath)).toBe(true);
    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
    })).resolves.toMatchObject({ status: 'cache-hit' });
  });

  it('re-syncs an EEXIST sha directory after parent sync failure', async () => {
    const cacheRoot = prepareCacheRoot();
    const first = await stagePack(makeRoot('takt-github-download-'));
    let failed = false;
    await expect(materializeGithubTemplateCache({
      staged: first.staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase) {
          if (
            phase === 'before-cache-directory-parent-fsync'
            && !failed
          ) {
            failed = true;
            throw new Error('injected parent sync failure');
          }
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });

    const shaRoot = join(cacheRoot, 'sha256');
    writeFileSync(
      join(shaRoot, `${sha256(first.content)}.taktpack`),
      first.content,
      { mode: 0o600 },
    );
    const second = await stagePack(makeRoot('takt-github-download-'));
    await expect(materializeGithubTemplateCache({
      staged: second.staged,
      cacheRoot,
    })).resolves.toMatchObject({ status: 'cache-hit' });
  });

  it('never overwrites or deletes an invalid existing final', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    const cachePath = writeExistingCache(cacheRoot, content);
    writeFileSync(cachePath, 'ghp_corrupt_cache_secret');

    const error = await materializeGithubTemplateCache({
      staged,
      cacheRoot,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'CACHE_INVALID',
      artifactState: 'cache-published',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_corrupt_cache_secret',
    );
    expect(readFileSync(cachePath).toString()).toBe(
      'ghp_corrupt_cache_secret',
    );
  });

  it.each(['mode', 'hardlink', 'symlink'] as const)(
    'rejects unsafe existing final: %s',
    async (tamper) => {
      const cacheRoot = prepareCacheRoot();
      const { content, staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const cachePath = writeExistingCache(cacheRoot, content);
      if (tamper === 'mode') chmodSync(cachePath, 0o644);
      if (tamper === 'hardlink') linkSync(cachePath, `${cachePath}.alias`);
      if (tamper === 'symlink') {
        const external = join(makeRoot('takt-cache-external-'), 'asset');
        writeFileSync(external, content);
        unlinkSync(cachePath);
        symlinkSync(external, cachePath);
      }

      await expect(materializeGithubTemplateCache({
        staged,
        cacheRoot,
      })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    },
  );

  it('rejects a symlink cache root without following it', async () => {
    const parent = makeRoot('takt-cache-parent-');
    const outside = prepareCacheRoot();
    const cacheRoot = join(parent, 'linked-cache');
    symlinkSync(outside, cacheRoot);
    const { staged } = await stagePack(makeRoot('takt-github-download-'));

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('rejects cache roots reached through a symlink ancestor', async () => {
    const parent = makeRoot('takt-cache-parent-');
    const outside = prepareCacheRoot();
    const linkedParent = join(parent, 'linked-parent');
    symlinkSync(outside, linkedParent);
    const cacheRoot = join(linkedParent, 'private-cache');
    mkdirSync(join(outside, 'private-cache'), { mode: 0o700 });
    const { staged } = await stagePack(makeRoot('takt-github-download-'));

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it('does not return cache-hit when sha parent fsync fails', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    writeExistingCache(cacheRoot, content);

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase) {
          if (phase === 'before-cache-hit-parent-fsync') {
            throw new Error('ghp_cache_fsync_secret');
          }
        },
      },
    })).rejects.toMatchObject({ code: 'IO_FAILURE' });
    expect(existsSync(staged.stagingPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'classifies a native cache directory fsync failure as I/O',
    async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    writeExistingCache(cacheRoot, content);

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        cacheFsync() {
          throw new Error('ghp_native_fsync_secret');
        },
      },
    })).rejects.toMatchObject({
      code: 'IO_FAILURE',
      artifactState: 'cache-published',
    });
    expect(existsSync(staged.stagingPath)).toBe(false);
    },
  );

  it('rejects a sha directory replaced before cache-hit durability sync', async () => {
    const cacheRoot = prepareCacheRoot();
    const outside = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    writeExistingCache(cacheRoot, content);
    writeExistingCache(outside, content);
    const shaRoot = join(cacheRoot, 'sha256');
    const displaced = join(cacheRoot, 'sha256.displaced');

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase) {
          if (phase === 'before-cache-hit-parent-fsync') {
            renameSync(shaRoot, displaced);
            symlinkSync(join(outside, 'sha256'), shaRoot);
          }
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
    expect(realpathSync.native(shaRoot)).toBe(
      realpathSync.native(join(outside, 'sha256')),
    );
  });

  it.each(['symlink-replacement', 'same-inode-mutation'] as const)(
    'rejects final cache tampering before durability sync: %s',
    async (tamper) => {
      const cacheRoot = prepareCacheRoot();
      const outside = prepareCacheRoot();
      const { content, staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const cachePath = writeExistingCache(cacheRoot, content);
      const outsidePath = writeExistingCache(outside, content);

      await expect(materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: {
          onCachePhase(phase) {
            if (phase !== 'before-cache-hit-parent-fsync') return;
            if (tamper === 'symlink-replacement') {
              unlinkSync(cachePath);
              symlinkSync(outsidePath, cachePath);
              return;
            }
            const mutated = Buffer.from(content);
            mutated[mutated.byteLength - 1] ^= 0xff;
            writeFileSync(cachePath, mutated, { mode: 0o600 });
          },
        },
      })).rejects.toMatchObject({
        code: 'CACHE_INVALID',
        artifactState: 'cache-published',
      });
    },
  );

  it('rejects a sha directory replaced during staging cleanup', async () => {
    const cacheRoot = prepareCacheRoot();
    const outside = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    writeExistingCache(cacheRoot, content);
    writeExistingCache(outside, content);
    const shaRoot = join(cacheRoot, 'sha256');
    const displaced = join(cacheRoot, 'sha256.displaced');

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase) {
          if (phase === 'before-staging-cleanup') {
            renameSync(shaRoot, displaced);
            symlinkSync(join(outside, 'sha256'), shaRoot);
          }
        },
      },
    })).rejects.toMatchObject({
      code: 'CACHE_INVALID',
      artifactState: 'cache-published',
    });
  });

  it('preserves a verified cache when staging cleanup fails', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    const cachePath = writeExistingCache(cacheRoot, content);

    const error = await materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase) {
          if (phase === 'before-staging-cleanup') {
            throw new Error('ghp_cleanup_secret');
          }
        },
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'CLEANUP_FAILED',
      artifactState: 'cache-published',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_cleanup_secret',
    );
    expect(readFileSync(cachePath)).toEqual(content);
  });

  it('detects tampering between final hash and inspection', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    const cachePath = writeExistingCache(cacheRoot, content);

    await expect(materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        onCachePhase(phase) {
          if (phase === 'before-cache-final-inspect') {
            writeFileSync(cachePath, Buffer.alloc(content.byteLength));
          }
        },
      },
    })).rejects.toMatchObject({ code: 'CACHE_INVALID' });
  });

  it.each(['link', 'unlink', 'close'] as const)(
    'normalizes authentic internal errors rethrown by cache %s seam',
    async (operation) => {
      const authentic = await stageGithubTemplateDownload({
        projectRoot: '',
        expectedBytes: 0,
        expectedSha256: '',
        chunks: chunks(),
      }).catch((caught: unknown) => caught) as
        GithubTemplateDownloadStorageError;
      expect(authentic.code).toBe('INVALID_ARGUMENT');

      const cacheRoot = prepareCacheRoot();
      const { staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const error = await materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: operation === 'link'
          ? { cacheLink: () => { throw authentic; } }
          : operation === 'unlink'
            ? { cacheUnlink: () => { throw authentic; } }
            : {
              cacheClose(_fd, kind) {
                if (kind === 'temporary') throw authentic;
              },
            },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'IO_FAILURE' });
      expect(error).not.toBe(authentic);
    },
  );
});
describe('GitHub template cache publication alias safety', () => {
  it.each([
    'before-cache-publish-parent-fsync',
    'before-cache-temp-unlink',
  ] as const)(
    'retains temp when final alias disappears at %s',
    async (faultPhase) => {
      const cacheRoot = prepareCacheRoot();
      const { content, staged } = await stagePack(
        makeRoot('takt-github-download-'),
      );
      const finalPath = join(
        cacheRoot,
        'sha256',
        `${sha256(content)}.taktpack`,
      );

      const error = await materializeGithubTemplateCache({
        staged,
        cacheRoot,
        ioSeam: {
          onCachePhase(phase) {
            if (phase === faultPhase) unlinkSync(finalPath);
          },
        },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: 'CACHE_INVALID',
        artifactState: 'staging-only',
      });
      expect(existsSync(finalPath)).toBe(false);
      expect(
        readdirSync(join(cacheRoot, 'sha256')).filter(
          (entry) => entry.startsWith('.tmp.'),
        ),
      ).toHaveLength(1);
      expect(existsSync(staged.stagingPath)).toBe(false);
    },
  );

  it('does not treat a forged cacheLink EEXIST seam error as native race', async () => {
    const cacheRoot = prepareCacheRoot();
    const { content, staged } = await stagePack(
      makeRoot('takt-github-download-'),
    );
    const finalPath = join(
      cacheRoot,
      'sha256',
      `${sha256(content)}.taktpack`,
    );

    const error = await materializeGithubTemplateCache({
      staged,
      cacheRoot,
      ioSeam: {
        cacheLink() {
          throw Object.assign(new Error('ghp_forged_eexist_secret'), {
            code: 'EEXIST',
          });
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'IO_FAILURE',
      artifactState: 'none',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_forged_eexist_secret',
    );
    expect(existsSync(finalPath)).toBe(false);
    expect(readdirSync(join(cacheRoot, 'sha256'))).toEqual([]);
  });

});

describe('GitHub template cache orphan reclaim', () => {
  it('deletes dead nlink1 temps but retains live, current, and EPERM owners', async () => {
    const cacheRoot = prepareCacheRoot();
    mkdirSync(join(cacheRoot, 'sha256'), { mode: 0o700 });
    const sha = 'a'.repeat(64);
    const dead = cacheTempPath(cacheRoot, 900001, sha);
    const live = cacheTempPath(
      cacheRoot,
      900002,
      sha,
      '223e4567-e89b-42d3-a456-426614174000',
    );
    const current = cacheTempPath(
      cacheRoot,
      process.pid,
      sha,
      '323e4567-e89b-42d3-a456-426614174000',
    );
    const unknown = cacheTempPath(
      cacheRoot,
      900003,
      sha,
      '423e4567-e89b-42d3-a456-426614174000',
    );
    for (const path of [dead, live, current, unknown]) {
      writeFileSync(path, '', { mode: 0o600 });
    }

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe(pid) {
          if (pid === 900001) return deadProcessProbe(pid);
          if (pid === 900003) return 'inaccessible';
          return 'alive';
        },
      },
    });

    expect(result).toMatchObject({
      reclaimed: 1,
      matched: 4,
      skipped: 3,
      truncated: false,
      status: 'complete',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect([live, current, unknown].every(existsSync)).toBe(true);
  });

  it('removes only the temp alias of a fully verified nlink2 final', async () => {
    const cacheRoot = prepareCacheRoot();
    const sourceRoot = makeRoot('takt-reclaim-source-');
    const content = await makePack(sourceRoot);
    const sha = sha256(content);
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 900010, sha);
    const final = join(shaRoot, `${sha}.taktpack`);
    writeFileSync(temp, content, { mode: 0o600 });
    linkSync(temp, final);

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: { cacheProcessProbe: deadProcessProbe },
    });

    expect(result.reclaimed).toBe(1);
    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(final)).toEqual(content);
    expect(lstatSync(final).nlink).toBe(1);
  });

  it('retains malformed, unsafe, and invalid nlink2 candidates', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const sha = 'b'.repeat(64);
    const malformed = join(shaRoot, '.tmp.not-valid');
    const broad = cacheTempPath(cacheRoot, 900020, sha);
    const linked = cacheTempPath(
      cacheRoot,
      900021,
      sha,
      '523e4567-e89b-42d3-a456-426614174000',
    );
    writeFileSync(malformed, '', { mode: 0o600 });
    writeFileSync(broad, '', { mode: 0o644 });
    writeFileSync(linked, 'invalid archive', { mode: 0o600 });
    linkSync(linked, join(shaRoot, `${sha}.taktpack`));

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: { cacheProcessProbe: deadProcessProbe },
    });

    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 2,
      unsafeRetained: 2,
      truncated: false,
      status: 'unsafe-retained',
    });
    expect([malformed, broad, linked].every(existsSync)).toBe(true);
  });

  it('bounds deletion to 32 entries', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    for (let index = 0; index < 33; index += 1) {
      writeFileSync(cacheTempPath(
        cacheRoot,
        910000 + index,
        index.toString(16).padStart(64, '0'),
        `${index.toString(16).padStart(8, '0')}-e89b-42d3-a456-426614174000`,
      ), '', { mode: 0o600 });
    }

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: { cacheProcessProbe: deadProcessProbe },
    });

    expect(result).toMatchObject({
      reclaimed: 32,
      truncated: true,
      status: 'delete-limit',
    });
  });

  it('bounds directory scanning to 8192 entries', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    for (let index = 0; index < 8192; index += 1) {
      writeFileSync(
        join(shaRoot, `unrelated-${index.toString().padStart(4, '0')}`),
        '',
        { mode: 0o600 },
      );
    }

    const result = await reclaimGithubTemplateCacheTemps({ cacheRoot });

    expect(result).toMatchObject({
      scanned: 8192,
      reclaimed: 0,
      truncated: true,
      status: 'scan-limit',
    });
  });

  it('retains a candidate when the owner PID becomes live before unlink', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 915000, 'd'.repeat(64));
    writeFileSync(temp, '', { mode: 0o600 });
    let probes = 0;

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe() {
          probes += 1;
          return probes === 1 ? 'missing' : 'alive';
        },
      },
    });

    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 1,
      unsafeRetained: 1,
    });
    expect(probes).toBe(2);
    expect(existsSync(temp)).toBe(true);
  });

  it('retains a sole temp inode when its canonical final path exists', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const sha = 'e'.repeat(64);
    const temp = cacheTempPath(cacheRoot, 916000, sha);
    writeFileSync(temp, '', { mode: 0o600 });
    writeFileSync(join(shaRoot, `${sha}.taktpack`), '', { mode: 0o600 });

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: { cacheProcessProbe: deadProcessProbe },
    });

    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 1,
      unsafeRetained: 1,
    });
    expect(existsSync(temp)).toBe(true);
  });

  it('retains symlink and over-linked candidates', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    const externalRoot = makeRoot('takt-reclaim-external-');
    mkdirSync(shaRoot, { mode: 0o700 });
    const sha = 'f'.repeat(64);
    const symlink = cacheTempPath(cacheRoot, 916010, sha);
    const linked = cacheTempPath(
      cacheRoot,
      916011,
      sha,
      '623e4567-e89b-42d3-a456-426614174000',
    );
    const external = join(externalRoot, 'external');
    writeFileSync(external, '', { mode: 0o600 });
    symlinkSync(external, symlink);
    writeFileSync(linked, '', { mode: 0o600 });
    linkSync(linked, join(externalRoot, 'alias-1'));
    linkSync(linked, join(externalRoot, 'alias-2'));

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: { cacheProcessProbe: deadProcessProbe },
    });

    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 2,
      unsafeRetained: 2,
    });
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(lstatSync(linked).nlink).toBe(3);
  });

  it('retains the replacement when a candidate path changes before unlink', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    const externalRoot = makeRoot('takt-reclaim-swap-');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 916020, '1'.repeat(64));
    const external = join(externalRoot, 'external');
    writeFileSync(temp, '', { mode: 0o600 });
    writeFileSync(external, 'do-not-delete', { mode: 0o600 });

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        onCachePhase(phase) {
          if (phase === 'before-cache-reclaim-unlink') {
            unlinkSync(temp);
            symlinkSync(external, temp);
          }
        },
      },
    });

    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 1,
      unsafeRetained: 1,
    });
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, 'utf8')).toBe('do-not-delete');
  });

  it('retains a linked candidate mutated after semantic inspection', async () => {
    const cacheRoot = prepareCacheRoot();
    const sourceRoot = makeRoot('takt-reclaim-mutation-source-');
    const content = await makePack(sourceRoot);
    const sha = sha256(content);
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 916025, sha);
    const final = join(shaRoot, `${sha}.taktpack`);
    writeFileSync(temp, content, { mode: 0o600 });
    linkSync(temp, final);

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        onCachePhase(phase) {
          if (phase === 'before-cache-reclaim-unlink') {
            writeFileSync(final, Buffer.alloc(content.byteLength));
          }
        },
      },
    });

    expect(result).toMatchObject({
      reclaimed: 0,
      skipped: 1,
      unsafeRetained: 1,
    });
    expect(existsSync(temp)).toBe(true);
    expect(lstatSync(final).nlink).toBe(2);
  });

  it('reclaims before materialization and blocks publication on reclaim fault', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const orphan = cacheTempPath(cacheRoot, 916030, '2'.repeat(64));
    writeFileSync(orphan, '', { mode: 0o600 });
    const first = await stagePack(makeRoot('takt-reclaim-materialize-'));

    await expect(materializeGithubTemplateCache({
      staged: first.staged,
      cacheRoot,
      ioSeam: { cacheProcessProbe: deadProcessProbe },
    })).resolves.toMatchObject({ status: 'cache-published' });
    expect(existsSync(orphan)).toBe(false);

    const blockedCacheRoot = prepareCacheRoot();
    const blockedShaRoot = join(blockedCacheRoot, 'sha256');
    mkdirSync(blockedShaRoot, { mode: 0o700 });
    const blockedOrphan = cacheTempPath(
      blockedCacheRoot,
      916031,
      '3'.repeat(64),
      '723e4567-e89b-42d3-a456-426614174000',
    );
    writeFileSync(blockedOrphan, '', { mode: 0o600 });
    const second = await stagePack(makeRoot('takt-reclaim-blocked-'));
    const error = await materializeGithubTemplateCache({
      staged: second.staged,
      cacheRoot: blockedCacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        onCachePhase(phase) {
          if (phase === 'before-cache-reclaim-unlink') {
            throw new Error('ghp_reclaim_materialize_secret');
          }
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'IO_FAILURE',
      artifactState: 'none',
    });
    expect(String((error as Error).message)).not.toContain(
      'ghp_reclaim_materialize_secret',
    );
    expect(existsSync(blockedOrphan)).toBe(true);
    expect(existsSync(second.staged.stagingPath)).toBe(false);
    expect(
      existsSync(join(blockedShaRoot, `${second.staged.sha256}.taktpack`)),
    ).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'durably syncs prior deletions when a later candidate fails',
    async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    for (let index = 0; index < 2; index += 1) {
      writeFileSync(cacheTempPath(
        cacheRoot,
        917000 + index,
        `${index + 4}`.repeat(64),
        `${index + 8}23e4567-e89b-42d3-a456-426614174000`,
      ), '', { mode: 0o600 });
    }
    let unlinks = 0;
    let directorySyncs = 0;

    const error = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        cacheFsync() {
          directorySyncs += 1;
        },
        onCachePhase(phase) {
          if (phase === 'before-cache-reclaim-unlink') {
            unlinks += 1;
            if (unlinks === 2) throw new Error('later candidate failed');
          }
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'IO_FAILURE' });
    expect(unlinks).toBe(2);
    expect(directorySyncs).toBe(1);
    expect(readdirSync(shaRoot)).toHaveLength(1);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'revalidates a retained nlink2 final after unlink and directory fsync',
    async () => {
    const cacheRoot = prepareCacheRoot();
    const content = await makePack(makeRoot('takt-reclaim-post-fsync-'));
    const sha = sha256(content);
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 917010, sha);
    const final = join(shaRoot, `${sha}.taktpack`);
    writeFileSync(temp, content, { mode: 0o600 });
    linkSync(temp, final);
    let finalCloses = 0;

    const error = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        cacheFsync() {
          writeFileSync(final, Buffer.alloc(content.byteLength));
        },
        cacheClose(_fd, kind) {
          if (kind === 'final') {
            finalCloses += 1;
            throw new Error('secondary close failure');
          }
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(existsSync(temp)).toBe(false);
    expect(lstatSync(final).nlink).toBe(1);
    expect(finalCloses).toBe(1);
    },
  );

  it('revalidates nlink2 final immediately after unlink on every platform', async () => {
    const cacheRoot = prepareCacheRoot();
    const content = await makePack(makeRoot('takt-reclaim-post-unlink-'));
    const sha = sha256(content);
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 917015, sha);
    const final = join(shaRoot, `${sha}.taktpack`);
    writeFileSync(temp, content, { mode: 0o600 });
    linkSync(temp, final);

    const error = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        onCachePhase(phase) {
          if ((phase as string) === 'after-cache-reclaim-unlink') {
            writeFileSync(final, Buffer.alloc(content.byteLength));
          }
        },
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'CACHE_INVALID' });
    expect(existsSync(temp)).toBe(false);
    expect(lstatSync(final).nlink).toBe(1);
  });

  it('fails closed when unsafe candidate descriptor close fails', async () => {
    for (const scenario of ['path', 'hash', 'inspection'] as const) {
      const cacheRoot = prepareCacheRoot();
      const shaRoot = join(cacheRoot, 'sha256');
      mkdirSync(shaRoot, { mode: 0o700 });
      const invalidContent = Buffer.from('invalid archive');
      const sha = scenario === 'inspection'
        ? sha256(invalidContent)
        : '7'.repeat(64);
      const closeKind = scenario === 'path' ? 'temporary' : 'final';
      const temp = cacheTempPath(
        cacheRoot,
        917017,
        sha,
        scenario === 'path'
          ? '823e4567-e89b-42d3-a456-426614174000'
          : scenario === 'hash'
            ? '923e4567-e89b-42d3-a456-426614174000'
            : 'a23e4567-e89b-42d3-a456-426614174000',
      );
      writeFileSync(temp, invalidContent, { mode: 0o600 });
      if (scenario === 'path') {
        writeFileSync(join(shaRoot, `${sha}.taktpack`), '', { mode: 0o600 });
      } else {
        linkSync(temp, join(shaRoot, `${sha}.taktpack`));
      }
      let closeCalls = 0;

      const error = await reclaimGithubTemplateCacheTemps({
        cacheRoot,
        ioSeam: {
          cacheProcessProbe: deadProcessProbe,
          cacheClose(_fd, currentKind) {
            if (currentKind === closeKind) {
              closeCalls += 1;
              throw new Error('ghp_unsafe_candidate_close_secret');
            }
          },
        },
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'IO_FAILURE' });
      expect(String((error as Error).message)).not.toContain(
        'ghp_unsafe_candidate_close_secret',
      );
      expect(closeCalls).toBe(1);
      expect(existsSync(temp)).toBe(true);
    }
  });

  it('retains nlink2 when its final alias disappears before unlink', async () => {
    const cacheRoot = prepareCacheRoot();
    const content = await makePack(makeRoot('takt-reclaim-final-loss-'));
    const sha = sha256(content);
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 917020, sha);
    const final = join(shaRoot, `${sha}.taktpack`);
    writeFileSync(temp, content, { mode: 0o600 });
    linkSync(temp, final);

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe: deadProcessProbe,
        onCachePhase(phase) {
          if (phase === 'before-cache-reclaim-unlink') unlinkSync(final);
        },
      },
    });

    expect(result.reclaimed).toBe(0);
    expect(existsSync(temp)).toBe(true);
    expect(lstatSync(temp).nlink).toBe(1);
  });

  it('revalidates after the second missing-owner probe mutates nlink2', async () => {
    const cacheRoot = prepareCacheRoot();
    const content = await makePack(makeRoot('takt-reclaim-probe-mutate-'));
    const sha = sha256(content);
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 917030, sha);
    const final = join(shaRoot, `${sha}.taktpack`);
    writeFileSync(temp, content, { mode: 0o600 });
    linkSync(temp, final);
    let probes = 0;

    const result = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: {
        cacheProcessProbe() {
          probes += 1;
          if (probes === 2) {
            writeFileSync(final, Buffer.alloc(content.byteLength));
          }
          return 'missing';
        },
      },
    });

    expect(probes).toBe(2);
    expect(result.reclaimed).toBe(0);
    expect(existsSync(temp)).toBe(true);
    expect(lstatSync(final).nlink).toBe(2);
  });

  it('does not trust thrown ESRCH or invalid process seam results', async () => {
    for (const probe of [
      () => {
        throw Object.assign(new Error('forged missing'), { code: 'ESRCH' });
      },
      () => 'missing-forged',
    ]) {
      const cacheRoot = prepareCacheRoot();
      const shaRoot = join(cacheRoot, 'sha256');
      mkdirSync(shaRoot, { mode: 0o700 });
      const temp = cacheTempPath(cacheRoot, 917040, '9'.repeat(64));
      writeFileSync(temp, '', { mode: 0o600 });

      const result = await reclaimGithubTemplateCacheTemps({
        cacheRoot,
        ioSeam: {
          cacheProcessProbe: probe as never,
        },
      });

      expect(result.reclaimed).toBe(0);
      expect(existsSync(temp)).toBe(true);
    }
  });

  it('fails closed without deleting when the process seam is a hostile Proxy', async () => {
    const cacheRoot = prepareCacheRoot();
    const shaRoot = join(cacheRoot, 'sha256');
    mkdirSync(shaRoot, { mode: 0o700 });
    const temp = cacheTempPath(cacheRoot, 917045, '8'.repeat(64));
    writeFileSync(temp, '', { mode: 0o600 });
    const ioSeam = new Proxy({}, {
      get() {
        throw new Error('ghp_reclaim_probe_proxy_secret');
      },
    });

    const error = await reclaimGithubTemplateCacheTemps({
      cacheRoot,
      ioSeam: ioSeam as never,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'IO_FAILURE' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_reclaim_probe_proxy_secret',
    );
    expect(existsSync(temp)).toBe(true);
  });

  it.each([
    ['getter', (() => {
      const value = {};
      Object.defineProperty(value, 'cacheRoot', {
        get() {
          throw new Error('ghp_reclaim_option_secret');
        },
      });
      return value;
    })()],
    ['proxy', new Proxy({}, {
      ownKeys() {
        throw new Error('ghp_reclaim_option_secret');
      },
    })],
    ['unknown key', { unknown: true }],
    ['symbol key', { [Symbol('secret')]: true }],
    ['non-plain prototype', Object.create({ cacheRoot: '/tmp' })],
  ])('rejects unsafe reclaim options: %s', async (_label, options) => {
    const error = await reclaimGithubTemplateCacheTemps(
      options as never,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(String((error as Error).message)).not.toContain(
      'ghp_reclaim_option_secret',
    );
  });

  it('fails closed when scan, final, or root descriptor close fails', async () => {
    for (const fault of ['scan', 'final', 'root'] as const) {
      const cacheRoot = prepareCacheRoot();
      const shaRoot = join(cacheRoot, 'sha256');
      mkdirSync(shaRoot, { mode: 0o700 });
      let temp: string | undefined;
      if (fault === 'final') {
        const content = await makePack(makeRoot('takt-reclaim-close-'));
        const sha = sha256(content);
        temp = cacheTempPath(cacheRoot, 917050, sha);
        writeFileSync(temp, content, { mode: 0o600 });
        linkSync(temp, join(shaRoot, `${sha}.taktpack`));
      }
      const error = await reclaimGithubTemplateCacheTemps({
        cacheRoot,
        ioSeam: {
          cacheProcessProbe: deadProcessProbe,
          cacheClose(_fd, kind) {
            if (fault === 'final' && kind === 'final') {
              throw new Error('ghp_reclaim_close_secret');
            }
            if (fault === 'root' && kind === 'directory') {
              throw new Error('ghp_reclaim_close_secret');
            }
          },
          cacheReclaimClose(kind: string) {
            if (fault === 'scan' && kind === 'directory-stream') {
              throw new Error('ghp_reclaim_close_secret');
            }
          },
        } as never,
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'IO_FAILURE' });
      expect(String((error as Error).message)).not.toContain(
        'ghp_reclaim_close_secret',
      );
      if (fault === 'final') expect(existsSync(temp!)).toBe(false);
    }
  });

  it('redacts unlink and fsync reclaim faults', async () => {
    for (const fault of ['unlink', 'fsync'] as const) {
      const cacheRoot = prepareCacheRoot();
      const shaRoot = join(cacheRoot, 'sha256');
      mkdirSync(shaRoot, { mode: 0o700 });
      writeFileSync(
        cacheTempPath(cacheRoot, 920000, 'c'.repeat(64)),
        '',
        { mode: 0o600 },
      );
      const error = await reclaimGithubTemplateCacheTemps({
        cacheRoot,
        ioSeam: {
          cacheProcessProbe: deadProcessProbe,
          onCachePhase(phase) {
            if (
              (fault === 'unlink' && phase === 'before-cache-reclaim-unlink')
              || (fault === 'fsync' && phase === 'before-cache-reclaim-fsync')
            ) {
              throw new Error('ghp_reclaim_fault_secret');
            }
          },
        },
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'IO_FAILURE' });
      expect(String((error as Error).message)).not.toContain(
        'ghp_reclaim_fault_secret',
      );
    }
  });
});
