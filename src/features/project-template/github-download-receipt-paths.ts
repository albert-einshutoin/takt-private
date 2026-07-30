import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from 'node:path';
import { types } from 'node:util';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMP_NAME_PATTERN =
  /^\.tmp\.([1-9]\d*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([a-f0-9]{64})$/;
const MAX_CANONICAL_ROOT_LENGTH = 4096;
const MAX_PORTABLE_PID = 2_147_483_647;

export class GithubTemplateDownloadReceiptPathError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'GithubTemplateDownloadReceiptPathError';
  }
}

export interface GithubTemplateDownloadArtifactPaths {
  readonly artifactDirectory: string;
  readonly artifactPath: string;
}

export interface GithubTemplateDownloadReceiptLocatorPaths {
  readonly receiptAncestors: readonly string[];
  readonly receiptDirectory: string;
  readonly receiptPath: string;
}

export interface ParsedGithubTemplateDownloadReceiptTempName {
  readonly pid: number;
  readonly uuid: string;
  readonly receiptKey: string;
}

function pathError(message: string): GithubTemplateDownloadReceiptPathError {
  return Object.freeze(new GithubTemplateDownloadReceiptPathError(message));
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object'
    || value === null
    // Why: descriptor reads must never execute caller-controlled Proxy traps.
    || types.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key),
    )
    || Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor),
    )
  ) throw new Error();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
}

function requireSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error();
  }
  return value;
}

function requireCanonicalRoot(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_CANONICAL_ROOT_LENGTH
    || Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })
    || !isAbsolute(value)
    || resolve(value) !== value
    || parse(value).root === value
  ) throw new Error();
  return value;
}

function requirePortablePid(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) <= 0
    || (value as number) > MAX_PORTABLE_PID
  ) throw new Error();
  return value as number;
}

function requireUuidV4(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error();
  }
  return value;
}

function requireChildPath(
  parent: string,
  name: string,
): string {
  const path = join(parent, name);
  if (dirname(path) !== parent || basename(path) !== name) throw new Error();
  return path;
}

export function deriveGithubTemplateDownloadReceiptLocatorPaths(
  value: unknown,
): GithubTemplateDownloadReceiptLocatorPaths {
  try {
    const options = ownDataRecord(value, ['cacheRoot', 'receiptKey']);
    const cacheRoot = requireCanonicalRoot(options['cacheRoot']);
    const receiptKey = requireSha256(options['receiptKey']);
    const receipts = requireChildPath(cacheRoot, 'receipts');
    const version = requireChildPath(receipts, 'v1');
    const algorithm = requireChildPath(version, 'sha256');
    const receiptDirectory = requireChildPath(
      algorithm,
      receiptKey.slice(0, 2),
    );
    const receiptPath = requireChildPath(
      receiptDirectory,
      `${receiptKey}.json`,
    );
    return Object.freeze({
      receiptAncestors: Object.freeze([
        receipts,
        version,
        algorithm,
        receiptDirectory,
      ]),
      receiptDirectory,
      receiptPath,
    });
  } catch {
    throw pathError('GitHub template receipt path input is invalid');
  }
}

export function deriveGithubTemplateDownloadArtifactPaths(
  value: unknown,
): GithubTemplateDownloadArtifactPaths {
  try {
    const options = ownDataRecord(value, ['cacheRoot', 'archiveSha256']);
    const cacheRoot = requireCanonicalRoot(options['cacheRoot']);
    const archiveSha256 = requireSha256(options['archiveSha256']);
    const artifactDirectory = requireChildPath(cacheRoot, 'sha256');
    const artifactPath = requireChildPath(
      artifactDirectory,
      `${archiveSha256}.taktpack`,
    );
    return Object.freeze({
      artifactDirectory,
      artifactPath,
    });
  } catch {
    throw pathError('GitHub template artifact path input is invalid');
  }
}

export function createGithubTemplateDownloadReceiptTempName(
  value: unknown,
): string {
  try {
    const options = ownDataRecord(value, ['pid', 'uuid', 'receiptKey']);
    const pid = requirePortablePid(options['pid']);
    const uuid = requireUuidV4(options['uuid']);
    const receiptKey = requireSha256(options['receiptKey']);
    return `.tmp.${pid}.${uuid}.${receiptKey}`;
  } catch {
    throw pathError('GitHub template receipt temporary name input is invalid');
  }
}

export function parseGithubTemplateDownloadReceiptTempName(
  value: unknown,
): ParsedGithubTemplateDownloadReceiptTempName {
  try {
    if (typeof value !== 'string') throw new Error();
    const match = TEMP_NAME_PATTERN.exec(value);
    if (match === null) throw new Error();
    const pid = requirePortablePid(Number(match[1]));
    if (String(pid) !== match[1]) throw new Error();
    return Object.freeze({
      pid,
      uuid: requireUuidV4(match[2]),
      receiptKey: requireSha256(match[3]),
    });
  } catch {
    throw pathError('GitHub template receipt temporary name is invalid');
  }
}
