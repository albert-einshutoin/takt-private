import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type LeaseMode = 'read' | 'write';

type RepertoireCoordinationLease = {
  readonly mode: LeaseMode;
  release(): Promise<void> | void;
};

type RepertoireCoordinationError = Error & {
  readonly code: 'ABORTED' | 'TIMEOUT' | 'UNSAFE_STATE' | 'WRITER_PENDING';
};

type CoordinationModule = {
  readonly REPERTOIRE_COORDINATION_LOCK_ORDER: readonly string[];
  acquireRepertoireCoordinationLease(options: {
    globalConfigDir: string;
    mode: LeaseMode;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<RepertoireCoordinationLease>;
};

const moduleSourcePath = fileURLToPath(
  new URL('../../features/repertoire/coordination-lease.ts', import.meta.url),
);
const productionModuleExists = existsSync(moduleSourcePath);
const forceContract = process.env['TAKT_H1_FORCE_CONTRACT'] === '1';
const contractEnabled = productionModuleExists || forceContract;
const contractCaseCount = 17;
const roots: string[] = [];
const children = new Set<ChildProcess>();
const childOutput = new WeakMap<ChildProcess, { stdout: Buffer[]; stderr: Buffer[] }>();
let coordination: CoordinationModule;

describe('repertoire coordination contract activation', () => {
  it('never reports a zero-test false green and auto-enables when production exists', () => {
    expect(contractCaseCount).toBeGreaterThan(0);
    expect(contractEnabled).toBe(productionModuleExists || forceContract);
    if (productionModuleExists) expect(contractEnabled).toBe(true);
  });
});

const describeContract = contractEnabled
  ? describe
  : describe.skip;

describeContract(
  productionModuleExists
    ? 'repertoire global read/write lease contract'
    : forceContract
      ? 'repertoire global read/write lease contract (FORCED RED: production module must now satisfy this contract)'
      : 'repertoire global read/write lease contract (SKIPPED: production module is intentionally absent; set TAKT_H1_FORCE_CONTRACT=1 to prove RED)',
  () => {
    beforeAll(async () => {
      const moduleSpecifier: string = '../../features/repertoire/coordination-lease.js';
      coordination = await import(moduleSpecifier) as CoordinationModule;
    });

    it('allows independent readers to coexist', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const first = await acquire(globalConfigDir, 'read');
      const second = await acquire(globalConfigDir, 'read');

      expect(first.mode).toBe('read');
      expect(second.mode).toBe('read');

      await second.release();
      await first.release();
    });

    it('excludes a writer until all existing readers release', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const reader = await acquire(globalConfigDir, 'read');
      let writerSettled = false;
      const writerPromise = acquire(globalConfigDir, 'write', 2_000)
        .finally(() => { writerSettled = true; });

      await waitForWriterIntent(globalConfigDir);
      expect(writerSettled).toBe(false);

      await reader.release();
      const writer = await writerPromise;
      expect(writer.mode).toBe('write');
      await writer.release();
    });

    it('excludes a second writer until the first writer releases', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const first = await acquire(globalConfigDir, 'write');
      let secondSettled = false;
      const secondPromise = acquire(globalConfigDir, 'write', 2_000)
        .finally(() => { secondSettled = true; });

      await delay(75);
      expect(secondSettled).toBe(false);

      await first.release();
      const second = await secondPromise;
      await second.release();
    });

    it('rejects a new reader after writer intent is durable', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const reader = await acquire(globalConfigDir, 'read');
      const writerPromise = acquire(globalConfigDir, 'write', 2_000);
      await waitForWriterIntent(globalConfigDir);

      await expect(acquire(globalConfigDir, 'read', 500))
        .rejects.toMatchObject({ code: 'WRITER_PENDING' });

      await reader.release();
      const writer = await writerPromise;
      await writer.release();
    });

    it('enforces contention across child-process boundaries', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const readyPath = join(globalConfigDir, 'child.ready');
      const releasePath = join(globalConfigDir, 'child.release');
      const child = spawnChildLeaseHolder(globalConfigDir, readyPath, releasePath);

      await waitForPath(readyPath, 5_000);
      await expect(acquire(globalConfigDir, 'read', 150))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(TIMEOUT|WRITER_PENDING)$/) });

      writeFileSync(releasePath, 'release\n', { mode: 0o600, flag: 'wx' });
      await waitForChild(child);
    });

    it('keeps add mutation-free behind a writer and publishes only after release', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      mkdirSync(join(globalConfigDir, 'repertoire'), { recursive: true, mode: 0o700 });
      const packageDir = join(globalConfigDir, 'repertoire', '@owner', 'repo');
      const readyPath = join(globalConfigDir, 'add.ready');
      const writer = await acquire(globalConfigDir, 'write', 2_000);
      const child = spawnMutationChild(globalConfigDir, readyPath, 'add');

      await waitForPath(readyPath, 5_000);
      await delay(100);
      expect(existsSync(packageDir)).toBe(false);
      expect(packageResiduals(globalConfigDir)).toEqual([]);

      await writer.release();
      await waitForChild(child);
      expect(readFileSync(join(packageDir, 'facets', 'personas', 'coder.md'), 'utf8')).toBe('# coder\n');
      expect(packageResiduals(globalConfigDir)).toEqual([]);
      expect(releasedTombstones(globalConfigDir)).toBeGreaterThanOrEqual(2);
    });

    it('keeps remove mutation-free behind a writer and deletes quarantine after release', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const packageDir = join(globalConfigDir, 'repertoire', '@owner', 'repo');
      mkdirSync(packageDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(packageDir, 'sentinel'), 'installed\n');
      const readyPath = join(globalConfigDir, 'remove.ready');
      const writer = await acquire(globalConfigDir, 'write', 2_000);
      const child = spawnMutationChild(globalConfigDir, readyPath, 'remove');

      await waitForPath(readyPath, 5_000);
      await delay(100);
      expect(readFileSync(join(packageDir, 'sentinel'), 'utf8')).toBe('installed\n');
      expect(packageResiduals(globalConfigDir)).toEqual([]);

      await writer.release();
      await waitForChild(child);
      expect(existsSync(packageDir)).toBe(false);
      expect(packageResiduals(globalConfigDir)).toEqual([]);
      expect(releasedTombstones(globalConfigDir)).toBeGreaterThanOrEqual(2);
    });

    it('creates only private 0700 directories and 0600 coordination files', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const lease = await acquire(globalConfigDir, 'read');
      const artifacts = coordinationArtifacts(globalConfigDir);

      expect(artifacts.directories.length).toBeGreaterThan(0);
      expect(artifacts.files.length).toBeGreaterThan(0);
      for (const path of artifacts.directories) {
        expect(lstatSync(path).mode & 0o777, relative(globalConfigDir, path)).toBe(0o700);
      }
      for (const path of artifacts.files) {
        expect(lstatSync(path).mode & 0o777, relative(globalConfigDir, path)).toBe(0o600);
      }
      const ownershipEvidence = artifacts.files
        .map((path) => {
          try { return readLeasePayload(path); } catch { return undefined; }
        })
        .find((payload) => payload?.['pid'] === process.pid);
      expect(ownershipEvidence).toMatchObject({
        pid: process.pid,
        ...(process.getuid ? { uid: process.getuid() } : {}),
      });

      await lease.release();
    });

    it.each(['symlink', 'hardlink'] as const)(
      'fails closed when a prior lease path is replaced by a %s',
      async (kind) => {
        const globalConfigDir = makeGlobalConfigDir();
        const evidence = await discoverReaderLeaseEvidence(globalConfigDir);
        const leasePath = evidence.path;
        const source = join(globalConfigDir, `${kind}-source`);
        // Preserve a fully valid owner record so link type/count is the only
        // unsafe property exercised by this fixture.
        writeFileSync(source, `${JSON.stringify(evidence.payload)}\n`, { mode: 0o600 });
        if (kind === 'symlink') symlinkSync(source, leasePath);
        else linkSync(source, leasePath);

        await expect(acquire(globalConfigDir, 'write', 150))
          .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
        expect(existsSync(leasePath)).toBe(true);
      },
    );

    it.each([
      ['directory mode', (evidence: LeaseEvidence) => {
        writeLeasePayload(evidence.path, evidence.payload);
        chmodSync(dirname(evidence.path), 0o755);
      }],
      ['file mode', (evidence: LeaseEvidence) => {
        writeLeasePayload(evidence.path, evidence.payload);
        chmodSync(evidence.path, 0o644);
      }],
      ['pid', (evidence: LeaseEvidence) => {
        writeLeasePayload(evidence.path, { ...evidence.payload, pid: 0 });
      }],
      ['uid', (evidence: LeaseEvidence) => {
        const uid = evidence.payload['uid'];
        writeLeasePayload(evidence.path, {
          ...evidence.payload,
          uid: typeof uid === 'number' ? uid + 1 : 0,
        });
      }],
      ['token', (evidence: LeaseEvidence) => {
        writeLeasePayload(evidence.path, { ...evidence.payload, token: '' });
      }],
    ] as const)(
      'fails closed when only %s is unsafe',
      async (_label, makeUnsafe) => {
        const globalConfigDir = makeGlobalConfigDir();
        const evidence = await discoverReaderLeaseEvidence(globalConfigDir);
        makeUnsafe(evidence);

        await expect(acquire(globalConfigDir, 'write', 150))
          .rejects.toMatchObject({ code: 'UNSAFE_STATE' });
        expect(existsSync(evidence.path)).toBe(true);
      },
    );

    it('never auto-reclaims an apparently stale or dead owner', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const evidence = await discoverReaderLeaseEvidence(globalConfigDir);
      const leasePath = evidence.path;
      writeFileSync(leasePath, JSON.stringify({
        ...evidence.payload,
        pid: 2_147_483_647,
        createdAt: '2000-01-01T00:00:00.000Z',
      }), { mode: 0o600 });

      await expect(acquire(globalConfigDir, 'write', 150))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(TIMEOUT|UNSAFE_STATE)$/) });
      expect(existsSync(leasePath)).toBe(true);
    });

    it('supports AbortSignal cancellation without acquiring later', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const writer = await acquire(globalConfigDir, 'write');
      const controller = new AbortController();
      const waiting = coordination.acquireRepertoireCoordinationLease({
        globalConfigDir,
        mode: 'write',
        signal: controller.signal,
        timeoutMs: 2_000,
      });
      controller.abort();

      await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
      await writer.release();
      const next = await acquire(globalConfigDir, 'write');
      await next.release();
    });

    it('times out bounded waits and leaves no later lease claim behind', async () => {
      const globalConfigDir = makeGlobalConfigDir();
      const writer = await acquire(globalConfigDir, 'write');

      await expect(acquire(globalConfigDir, 'write', 75))
        .rejects.toMatchObject({ code: 'TIMEOUT' });
      await writer.release();

      const next = await acquire(globalConfigDir, 'read', 500);
      await next.release();
    });

    it('publishes the fixed global-before-project lock order as an external contract', () => {
      expect(coordination.REPERTOIRE_COORDINATION_LOCK_ORDER).toEqual([
        'global-repertoire',
        'project-template',
      ]);
      expect(Object.isFrozen(coordination.REPERTOIRE_COORDINATION_LOCK_ORDER)).toBe(true);
    });
  },
);

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeGlobalConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'takt-repertoire-lease-contract-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function acquire(globalConfigDir: string, mode: LeaseMode, timeoutMs = 500) {
  return coordination.acquireRepertoireCoordinationLease({
    globalConfigDir,
    mode,
    timeoutMs,
  });
}

function coordinationArtifacts(globalConfigDir: string): {
  directories: string[];
  files: string[];
} {
  const directories: string[] = [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(globalConfigDir);
  return { directories, files };
}

type LeaseEvidence = {
  path: string;
  payload: Record<string, unknown>;
};

async function discoverReaderLeaseEvidence(globalConfigDir: string): Promise<LeaseEvidence> {
  const lease = await acquire(globalConfigDir, 'read');
  const files = coordinationArtifacts(globalConfigDir).files;
  const leasePath = files.find((path) => {
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return payload['pid'] === process.pid && typeof payload['token'] === 'string';
    } catch {
      return false;
    }
  });
  expect(leasePath, 'an active reader must publish inspectable ownership evidence').toBeDefined();
  const payload = readLeasePayload(leasePath!);
  await lease.release();
  return { path: leasePath!, payload };
}

function readLeasePayload(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeLeasePayload(path: string, payload: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

async function waitForWriterIntent(globalConfigDir: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const hasIntent = coordinationArtifacts(globalConfigDir).files.some((path) => {
      try {
        const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        return payload['mode'] === 'write' || payload['kind'] === 'writer-intent';
      } catch {
        return false;
      }
    });
    if (hasIntent) return;
    await delay(10);
  }
  throw new Error('writer intent was not published within 2000ms');
}

function spawnChildLeaseHolder(
  globalConfigDir: string,
  readyPath: string,
  releasePath: string,
): ChildProcess {
  const vitestEntry = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const childTest = fileURLToPath(new URL('./coordination-lease-child.test.ts', import.meta.url));
  const child = spawn(process.execPath, [vitestEntry, 'run', childTest], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TAKT_REPERTOIRE_LEASE_CHILD: '1',
      TAKT_REPERTOIRE_LEASE_CONFIG_DIR: globalConfigDir,
      TAKT_REPERTOIRE_LEASE_READY_PATH: readyPath,
      TAKT_REPERTOIRE_LEASE_RELEASE_PATH: releasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  child.stdout?.on('data', (chunk: Buffer) => output.stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => output.stderr.push(chunk));
  childOutput.set(child, output);
  children.add(child);
  return child;
}

function spawnMutationChild(
  globalConfigDir: string,
  readyPath: string,
  action: 'add' | 'remove',
): ChildProcess {
  const vitestEntry = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const childTest = fileURLToPath(new URL('./mutation-coordination-child.test.ts', import.meta.url));
  mkdirSync(join(globalConfigDir, 'tmp'), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [vitestEntry, 'run', childTest], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TMPDIR: join(globalConfigDir, 'tmp'),
      TAKT_REPERTOIRE_MUTATION_CHILD: '1',
      TAKT_REPERTOIRE_MUTATION_ACTION: action,
      TAKT_REPERTOIRE_MUTATION_ROOT: globalConfigDir,
      TAKT_REPERTOIRE_MUTATION_READY_PATH: readyPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  child.stdout?.on('data', (chunk: Buffer) => output.stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => output.stderr.push(chunk));
  childOutput.set(child, output);
  children.add(child);
  return child;
}

function packageResiduals(globalConfigDir: string): string[] {
  const ownerDir = join(globalConfigDir, 'repertoire', '@owner');
  if (!existsSync(ownerDir)) return [];
  return readdirSync(ownerDir).filter((entry) => (
    entry.endsWith('.tmp') || entry.endsWith('.bak') || entry.startsWith('.remove-')
  ));
}

function releasedTombstones(globalConfigDir: string): number {
  const releasedDir = join(globalConfigDir, '.takt-repertoire-coordination', 'released');
  if (!existsSync(releasedDir)) return 0;
  return readdirSync(releasedDir).filter((entry) => entry.endsWith('.released')).length;
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await delay(20);
  if (!existsSync(path)) throw new Error(`timed out waiting for child readiness: ${path}`);
}

async function waitForChild(child: ChildProcess): Promise<void> {
  const output = childOutput.get(child) ?? { stdout: [], stderr: [] };
  const exitCode = child.exitCode ?? await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  children.delete(child);
  expect(
    exitCode,
    `child stdout:\n${Buffer.concat(output.stdout).toString()}\nchild stderr:\n${Buffer.concat(output.stderr).toString()}`,
  ).toBe(0);
}
