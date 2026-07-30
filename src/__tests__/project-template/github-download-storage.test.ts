import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  stageGithubTemplateDownload,
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
    })).rejects.toMatchObject({ code: 'UNSAFE_STAGING' });

    await expect(stageGithubTemplateDownload({
      projectRoot,
      expectedBytes: content.byteLength,
      expectedSha256: sha256(content),
      chunks: chunks(content),
    })).resolves.toMatchObject({ sha256: sha256(content) });
  });
});
