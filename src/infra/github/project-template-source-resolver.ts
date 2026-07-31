import { types } from 'node:util';
import type {
  GithubTemplateArchiveAssetPort,
} from '../../features/project-template/github-download-orchestrator.js';
import {
  GithubTemplateSourceResolutionError,
  resolveGithubTemplateSource,
  type GithubTemplateCurrentSourceEvidence,
  type GithubTemplateSourceMetadataPort,
  type ResolvedGithubTemplateSource,
} from '../../features/project-template/github-update-check.js';
import {
  parseProjectTemplateGithubSourceSpec,
} from '../../features/project-template/github-source-spec.js';
import {
  requestProjectTemplateGithubApiMetadata,
  type RequestProjectTemplateGithubApiMetadataOptions,
} from './project-template-api-transport.js';
import {
  acquireProjectTemplateGhCredential,
  type AcquireProjectTemplateGhCredentialOptions,
  type DisposableProjectTemplateGhCredential,
} from './project-template-gh-auth.js';

const MAX_JSON_METADATA_BYTES = 1024 * 1024;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const BUFFER_TO_STRING = Buffer.prototype.toString;

export interface ResolveAuthenticatedGithubTemplateSourceOptions {
  readonly source: string;
  readonly current?: GithubTemplateCurrentSourceEvidence;
  readonly checksumAssets: GithubTemplateArchiveAssetPort;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

export interface ProjectTemplateSourceResolverDependencies {
  readonly acquireCredential: (
    options: AcquireProjectTemplateGhCredentialOptions,
  ) => Promise<DisposableProjectTemplateGhCredential>;
  readonly requestMetadata: (
    options: RequestProjectTemplateGithubApiMetadataOptions,
  ) => Promise<Buffer>;
}

interface DependencySnapshot {
  readonly receiver: ProjectTemplateSourceResolverDependencies;
  readonly acquireCredential:
    ProjectTemplateSourceResolverDependencies['acquireCredential'];
  readonly requestMetadata:
    ProjectTemplateSourceResolverDependencies['requestMetadata'];
}

interface ChecksumPortSnapshot {
  readonly receiver: GithubTemplateArchiveAssetPort;
  readonly openReleaseAsset:
    GithubTemplateArchiveAssetPort['openReleaseAsset'];
}

interface OptionSnapshot {
  readonly source: string;
  readonly current?: GithubTemplateCurrentSourceEvidence;
  readonly checksumAssets: ChecksumPortSnapshot;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

interface CredentialSnapshot {
  readonly receiver: DisposableProjectTemplateGhCredential;
  readonly dispose: DisposableProjectTemplateGhCredential['dispose'];
}

interface FacadeControl {
  state: 'active' | 'closed';
  busy: boolean;
  credential: CredentialSnapshot | undefined;
}

const DEFAULT_DEPENDENCIES =
  Object.freeze<ProjectTemplateSourceResolverDependencies>({
    acquireCredential: acquireProjectTemplateGhCredential,
    requestMetadata: requestProjectTemplateGithubApiMetadata,
  });

function invalidArgument(): TypeError {
  return new TypeError(
    'Authenticated GitHub template source resolution input is invalid',
  );
}

function closedFacade(): Error {
  return Object.freeze(
    new Error('Authenticated GitHub metadata facade is closed'),
  );
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw invalidArgument();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some(
      (key) => typeof key !== 'string' || !keys.includes(key),
    )
  ) throw invalidArgument();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw invalidArgument();
    }
    record[key] = descriptor.value;
  }
  return record;
}

function snapshotSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== AbortSignal.prototype
  ) throw invalidArgument();
  try {
    if (
      ABORT_SIGNAL_ABORTED_GETTER === undefined
      || typeof Reflect.apply(
        ABORT_SIGNAL_ABORTED_GETTER,
        value,
        [],
      ) !== 'boolean'
    ) throw invalidArgument();
  } catch {
    throw invalidArgument();
  }
  return value as AbortSignal;
}

function snapshotCurrent(
  value: unknown,
): GithubTemplateCurrentSourceEvidence | undefined {
  if (value === undefined) return undefined;
  const record = exactDataRecord(value, [
    'owner',
    'repo',
    'repositoryUrl',
    'canonicalSource',
    'version',
    'sha256',
    'commit',
    'descriptorSha256',
  ]);
  return Object.freeze({ ...record }) as
    unknown as GithubTemplateCurrentSourceEvidence;
}

function snapshotChecksumPort(value: unknown): ChecksumPortSnapshot {
  const record = exactDataRecord(value, ['openReleaseAsset']);
  if (
    typeof record['openReleaseAsset'] !== 'function'
    || types.isProxy(record['openReleaseAsset'])
  ) throw invalidArgument();
  return Object.freeze({
    receiver: value as GithubTemplateArchiveAssetPort,
    openReleaseAsset: record['openReleaseAsset'] as
      GithubTemplateArchiveAssetPort['openReleaseAsset'],
  });
}

function snapshotOptions(
  value: ResolveAuthenticatedGithubTemplateSourceOptions,
): OptionSnapshot {
  const keys = (
    typeof value === 'object'
    && value !== null
    && !types.isProxy(value)
  ) ? Reflect.ownKeys(value) : [];
  const hasCurrent = keys.includes('current');
  const hasSignal = keys.includes('signal');
  const record = exactDataRecord(value, [
    'source',
    ...(hasCurrent ? ['current'] : []),
    'checksumAssets',
    'deadlineMs',
    ...(hasSignal ? ['signal'] : []),
  ]);
  if (
    typeof record['source'] !== 'string'
    || typeof record['deadlineMs'] !== 'number'
    || !Number.isFinite(record['deadlineMs'])
    || record['deadlineMs'] < 0
  ) throw invalidArgument();
  const current = snapshotCurrent(record['current']);
  const signal = snapshotSignal(record['signal']);
  return Object.freeze({
    source: record['source'],
    checksumAssets: snapshotChecksumPort(record['checksumAssets']),
    deadlineMs: record['deadlineMs'],
    ...(current === undefined ? {} : { current }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function snapshotDependencies(
  value: ProjectTemplateSourceResolverDependencies | undefined,
): DependencySnapshot {
  const receiver = value ?? DEFAULT_DEPENDENCIES;
  const record = exactDataRecord(receiver, [
    'acquireCredential',
    'requestMetadata',
  ]);
  for (const entry of Object.values(record)) {
    if (typeof entry !== 'function' || types.isProxy(entry)) {
      throw invalidArgument();
    }
  }
  return Object.freeze({
    receiver,
    acquireCredential: record['acquireCredential'] as
      DependencySnapshot['acquireCredential'],
    requestMetadata: record['requestMetadata'] as
      DependencySnapshot['requestMetadata'],
  });
}

function snapshotCredential(value: unknown): CredentialSnapshot {
  const record = exactDataRecord(value, ['dispose']);
  if (
    typeof record['dispose'] !== 'function'
    || types.isProxy(record['dispose'])
  ) throw closedFacade();
  return Object.freeze({
    receiver: value as DisposableProjectTemplateGhCredential,
    dispose: record['dispose'] as
      DisposableProjectTemplateGhCredential['dispose'],
  });
}

function snapshotCredentialCleanup(
  value: unknown,
): CredentialSnapshot | undefined {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'dispose');
  if (
    descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'function'
    || types.isProxy(descriptor.value)
  ) return undefined;
  return Object.freeze({
    receiver: value as DisposableProjectTemplateGhCredential,
    dispose: descriptor.value as
      DisposableProjectTemplateGhCredential['dispose'],
  });
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (ABORT_SIGNAL_ABORTED_GETTER === undefined) throw closedFacade();
  try {
    return Reflect.apply(
      ABORT_SIGNAL_ABORTED_GETTER,
      signal,
      [],
    ) as boolean;
  } catch {
    throw closedFacade();
  }
}

function requireActiveSignal(signal: AbortSignal | undefined): void {
  if (signalAborted(signal)) throw closedFacade();
}

function encodePath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function requestOptions(
  credential: DisposableProjectTemplateGhCredential,
  path: string,
  accept: RequestProjectTemplateGithubApiMetadataOptions['accept'],
  maxBytes: number,
  options: OptionSnapshot,
): RequestProjectTemplateGithubApiMetadataOptions {
  return Object.freeze({
    credential,
    path,
    accept,
    maxBytes,
    deadlineMs: options.deadlineMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function parseJsonBuffer(value: Buffer): unknown {
  try {
    return JSON.parse(Reflect.apply(
      BUFFER_TO_STRING,
      value,
      ['utf8'],
    ) as string) as unknown;
  } finally {
    Reflect.apply(TYPED_ARRAY_FILL, value, [0]);
  }
}

function copyAndWipeBuffer(value: Buffer): Uint8Array {
  try {
    if (
      TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
      || !Buffer.isBuffer(value)
      || types.isProxy(value)
    ) throw closedFacade();
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
    const copy = new Uint8Array(byteLength);
    Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
    return copy;
  } finally {
    if (Buffer.isBuffer(value) && !types.isProxy(value)) {
      Reflect.apply(TYPED_ARRAY_FILL, value, [0]);
    }
  }
}

function validateBoundedBuffer(value: unknown, maxBytes: number): Buffer {
  if (
    !Buffer.isBuffer(value)
    || types.isProxy(value)
    || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) throw closedFacade();
  const byteLength = Reflect.apply(
    TYPED_ARRAY_BYTE_LENGTH_GETTER,
    value,
    [],
  ) as number;
  if (byteLength > maxBytes) {
    Reflect.apply(TYPED_ARRAY_FILL, value, [0]);
    throw closedFacade();
  }
  return value;
}

function projectCommit(value: Buffer): unknown {
  const json = parseJsonBuffer(value);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw closedFacade();
  }
  return { commit: (json as Record<string, unknown>)['sha'] };
}

function projectRelease(value: Buffer): unknown {
  const json = parseJsonBuffer(value);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw closedFacade();
  }
  const record = json as Record<string, unknown>;
  if (!Array.isArray(record['assets'])) throw closedFacade();
  return {
    id: record['id'],
    tagName: record['tag_name'],
    assets: record['assets'].map((asset) => {
      if (
        typeof asset !== 'object'
        || asset === null
        || Array.isArray(asset)
      ) throw closedFacade();
      const fields = asset as Record<string, unknown>;
      return {
        id: fields['id'],
        name: fields['name'],
        size: fields['size'],
      };
    }),
  };
}

async function collectChecksum(
  port: ChecksumPortSnapshot,
  input: Parameters<GithubTemplateArchiveAssetPort['openReleaseAsset']>[0],
): Promise<Uint8Array> {
  requireActiveSignal(input.signal);
  let iterable: AsyncIterable<Uint8Array>;
  try {
    iterable = Reflect.apply(
      port.openReleaseAsset,
      port.receiver,
      [Object.freeze({ ...input })],
    );
  } catch {
    throw closedFacade();
  }
  const iterator = iterable[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await iterator.next();
      requireActiveSignal(input.signal);
      if (next.done === true) {
        complete = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) throw closedFacade();
      bytes += next.value.byteLength;
      if (bytes > input.maxBytes) throw closedFacade();
      chunks.push(next.value.slice());
    }
  } finally {
    if (!complete && typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // Bounded collection failure remains authoritative.
      }
    }
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  requireActiveSignal(input.signal);
  return result;
}

function createMetadataFacade(
  options: OptionSnapshot,
  dependencies: DependencySnapshot,
): {
  readonly facade: GithubTemplateSourceMetadataPort;
  readonly close: () => void;
} {
  const control: FacadeControl = {
    state: 'active',
    busy: false,
    credential: undefined,
  };

  const withMetadata = async (
    operation: (
      credential: DisposableProjectTemplateGhCredential,
    ) => Promise<unknown>,
  ): Promise<unknown> => {
    if (control.state !== 'active' || control.busy) throw closedFacade();
    requireActiveSignal(options.signal);
    control.busy = true;
    try {
      if (control.credential === undefined) {
        const acquired = await Reflect.apply(
          dependencies.acquireCredential,
          dependencies.receiver,
          [Object.freeze({
            deadlineMs: options.deadlineMs,
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
          })],
        );
        // Ownership starts at settlement, before exact-shape validation. This
        // keeps a malformed facade with a valid dispose hook reclaimable.
        control.credential = snapshotCredentialCleanup(acquired);
        requireActiveSignal(options.signal);
        control.credential = snapshotCredential(acquired);
      }
      const result = await operation(control.credential.receiver);
      requireActiveSignal(options.signal);
      return result;
    } finally {
      control.busy = false;
    }
  };

  const request = async (
    request: RequestProjectTemplateGithubApiMetadataOptions,
  ): Promise<Buffer> => {
    const value = await Reflect.apply(
      dependencies.requestMetadata,
      dependencies.receiver,
      [request],
    );
    const buffer = validateBoundedBuffer(value, request.maxBytes);
    if (signalAborted(options.signal)) {
      Reflect.apply(TYPED_ARRAY_FILL, buffer, [0]);
      throw closedFacade();
    }
    return buffer;
  };

  const facade = Object.freeze<GithubTemplateSourceMetadataPort>({
    resolveRefToCommit: (input) => withMetadata(async (credential) =>
      projectCommit(await request(
        requestOptions(
          credential,
          `/repos/${encodeURIComponent(input.owner)}`
            + `/${encodeURIComponent(input.repo)}/commits/`
            + encodeURIComponent(input.ref),
          'application/vnd.github+json',
          MAX_JSON_METADATA_BYTES,
          options,
        ),
      ))),
    readFileAtCommit: (input) => withMetadata(async (credential) => {
      const raw = await request(
        requestOptions(
          credential,
          `/repos/${encodeURIComponent(input.owner)}`
            + `/${encodeURIComponent(input.repo)}/contents/`
            + `${encodePath(input.path)}?ref=`
            + encodeURIComponent(input.commit),
          'application/vnd.github.raw+json',
          input.maxBytes,
          options,
        ),
      );
      return copyAndWipeBuffer(raw);
    }),
    getReleaseByTag: (input) => withMetadata(async (credential) =>
      projectRelease(await request(
        requestOptions(
          credential,
          `/repos/${encodeURIComponent(input.owner)}`
            + `/${encodeURIComponent(input.repo)}/releases/tags/`
            + encodeURIComponent(input.tag),
          'application/vnd.github+json',
          MAX_JSON_METADATA_BYTES,
          options,
        ),
      ))),
    readReleaseAsset: (input) => withMetadata(() => collectChecksum(
      options.checksumAssets,
      {
        owner: input.owner,
        repo: input.repo,
        releaseId: input.releaseId,
        assetId: input.assetId,
        maxBytes: input.maxBytes,
        ...(options.signal === undefined
          ? {}
          : { signal: options.signal }),
      },
    )),
  });

  return Object.freeze({
    facade,
    close(): void {
      if (control.state === 'closed') return;
      // Revocation precedes disposal so a reentrant cleanup hook cannot reuse
      // the short-lived credential through the retained private facade.
      control.state = 'closed';
      const credential = control.credential;
      control.credential = undefined;
      if (credential !== undefined) {
        try {
          Reflect.apply(
            credential.dispose,
            credential.receiver,
            [],
          );
        } catch {
          // Logical closure is final and secret-bearing cleanup errors never
          // replace the already selected resolution result.
        }
      }
    },
  });
}

export async function resolveAuthenticatedGithubTemplateSource(
  optionsValue: ResolveAuthenticatedGithubTemplateSourceOptions,
  dependenciesValue?: ProjectTemplateSourceResolverDependencies,
): Promise<ResolvedGithubTemplateSource> {
  let options: OptionSnapshot;
  let dependencies: DependencySnapshot;
  try {
    options = snapshotOptions(optionsValue);
    dependencies = snapshotDependencies(dependenciesValue);
  } catch {
    throw invalidArgument();
  }
  let source: ReturnType<typeof parseProjectTemplateGithubSourceSpec>;
  try {
    source = parseProjectTemplateGithubSourceSpec(options.source);
  } catch {
    throw Object.freeze(new GithubTemplateSourceResolutionError(
      'INVALID_SOURCE_SPEC',
      'GitHub template source is invalid',
      'source',
    ));
  }
  const metadata = createMetadataFacade(options, dependencies);
  try {
    const result = await resolveGithubTemplateSource({
      source,
      metadata: metadata.facade,
      ...(options.current === undefined
        ? {}
        : { current: options.current }),
    });
    if (signalAborted(options.signal)) {
      throw Object.freeze(new GithubTemplateSourceResolutionError(
        'METADATA_PORT_FAILURE',
        'GitHub metadata operation failed',
      ));
    }
    return result;
  } finally {
    metadata.close();
  }
}
