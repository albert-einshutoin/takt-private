import { Buffer } from 'node:buffer';
import { TextDecoder, types } from 'node:util';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node as YamlNode,
  type Pair,
} from 'yaml';
import {
  SEMVER_PATTERN_SOURCE,
} from '../../features/project-template/validation.js';

const MAX_LOCK_BYTES = 64 * 1024;
const SOURCE_PATTERN =
  /^github:(?![a-z0-9-]*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.{1,2}$)(?!.*\.git$)[a-z0-9._-]{1,100}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UTC_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMVER_PATTERN = new RegExp(SEMVER_PATTERN_SOURCE);
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
});
const UINT8_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype) as object,
    'byteLength',
  )!.get!;
const UINT8_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype) as object,
    'buffer',
  )!.get!;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_BUFFER_FROM = Buffer.from;
const CAPTURED_BUFFER_RECEIVER = Buffer;
const CAPTURED_DATE = Date;
const CAPTURED_DATE_TO_ISO_STRING = Date.prototype.toISOString;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_RECEIVER = Object;

export type ProjectTemplateRepertoireStrictLockErrorCode =
  | 'INVALID_ARGUMENT'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_ENCODING'
  | 'INVALID_YAML'
  | 'INVALID_LOCK';

const ERROR_MESSAGES:
Record<ProjectTemplateRepertoireStrictLockErrorCode, string> = {
  INVALID_ARGUMENT: 'Repertoire lock input is invalid',
  LIMIT_EXCEEDED: 'Repertoire lock byte limit was exceeded',
  INVALID_ENCODING: 'Repertoire lock encoding is invalid',
  INVALID_YAML: 'Repertoire lock YAML is invalid',
  INVALID_LOCK: 'Repertoire lock value is invalid',
};

export class ProjectTemplateRepertoireStrictLockError extends Error {
  constructor(
    public readonly code: ProjectTemplateRepertoireStrictLockErrorCode,
  ) {
    super(ERROR_MESSAGES[code]);
    const descriptor = CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_CREATE,
      CAPTURED_OBJECT_RECEIVER,
      [null],
    ) as PropertyDescriptor;
    descriptor.configurable = true;
    descriptor.enumerable = true;
    descriptor.value = 'ProjectTemplateRepertoireStrictLockError';
    descriptor.writable = true;
    CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_DEFINE_PROPERTY,
      CAPTURED_OBJECT_RECEIVER,
      [this, 'name', descriptor],
    );
  }
}

export interface ProjectTemplateRepertoireStrictLock {
  readonly source: `github:${string}/${string}`;
  readonly ref: string;
  readonly version: string;
  readonly commit: string;
  readonly importedAt: string;
}

function failure(
  code: ProjectTemplateRepertoireStrictLockErrorCode,
): ProjectTemplateRepertoireStrictLockError {
  return new ProjectTemplateRepertoireStrictLockError(code);
}

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function exactByteLength(value: unknown): number {
  if (
    typeof value !== 'object'
    || value === null
    || types.isProxy(value)
    || !types.isUint8Array(value)
  ) throw failure('INVALID_ARGUMENT');
  try {
    const buffer = CAPTURED_REFLECT_APPLY(
      UINT8_ARRAY_BUFFER_GETTER,
      value,
      [],
    );
    if (types.isSharedArrayBuffer(buffer)) {
      throw failure('INVALID_ARGUMENT');
    }
    return CAPTURED_REFLECT_APPLY(
      UINT8_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch {
    throw failure('INVALID_ARGUMENT');
  }
}

function copyBoundedBytes(value: unknown): Buffer {
  const byteLength = exactByteLength(value);
  if (byteLength > MAX_LOCK_BYTES) throw failure('LIMIT_EXCEEDED');
  try {
    return CAPTURED_REFLECT_APPLY(
      CAPTURED_BUFFER_FROM,
      CAPTURED_BUFFER_RECEIVER,
      [value],
    ) as Buffer;
  } catch {
    throw failure('INVALID_ARGUMENT');
  }
}

function rejectYamlFeatures(node: unknown): void {
  // Why: malformed YAML can be deeply nested even under the byte ceiling.
  // An explicit bounded worklist rejects it without recursive stack growth.
  const pending: unknown[] = [node];
  let visited = 0;
  while (pending.length !== 0) {
    const current = pending[pending.length - 1];
    pending.length -= 1;
    visited += 1;
    if (visited > 8192) throw failure('INVALID_YAML');
    if (isAlias(current)) throw failure('INVALID_YAML');
    if (typeof current !== 'object' || current === null) continue;
    const yamlNode = current as YamlNode;
    if (yamlNode.anchor !== undefined || yamlNode.tag !== undefined) {
      throw failure('INVALID_YAML');
    }
    if (isMap(current) || isSeq(current)) {
      for (let index = 0; index < current.items.length; index += 1) {
        const item = current.items[index]!;
        if (isMap(current)) {
          const pair = item as Pair;
          if (isScalar(pair.key) && pair.key.value === '<<') {
            throw failure('INVALID_YAML');
          }
          pending[pending.length] = pair.key;
          pending[pending.length] = pair.value;
        } else {
          pending[pending.length] = item;
        }
      }
    }
  }
}

function requireExactMap(
  contents: unknown,
): Record<'source' | 'ref' | 'commit' | 'imported_at', string> {
  if (!isMap(contents) || contents.items.length !== 4) {
    throw failure('INVALID_LOCK');
  }
  const values = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as Record<string, string>;
  for (let index = 0; index < contents.items.length; index += 1) {
    const pair = contents.items[index]!;
    if (
      !isScalar(pair.key)
      || typeof pair.key.value !== 'string'
      || !isScalar(pair.value)
      || typeof pair.value.value !== 'string'
    ) throw failure('INVALID_LOCK');
    const key = pair.key.value;
    if (
      key !== 'source'
      && key !== 'ref'
      && key !== 'commit'
      && key !== 'imported_at'
    ) throw failure('INVALID_LOCK');
    if (values[key] !== undefined) throw failure('INVALID_LOCK');
    values[key] = pair.value.value;
  }
  if (
    values['source'] === undefined
    || values['ref'] === undefined
    || values['commit'] === undefined
    || values['imported_at'] === undefined
  ) throw failure('INVALID_LOCK');
  return values as Record<
  'source' | 'ref' | 'commit' | 'imported_at',
  string
  >;
}

function requireCanonicalImportedAt(value: string): void {
  if (!UTC_ISO_PATTERN.test(value)) throw failure('INVALID_LOCK');
  let parsed: Date;
  try {
    parsed = new CAPTURED_DATE(value);
    if (
      CAPTURED_REFLECT_APPLY(
        CAPTURED_DATE_TO_ISO_STRING,
        parsed,
        [],
      ) !== value
    ) throw failure('INVALID_LOCK');
  } catch (error) {
    if (error instanceof ProjectTemplateRepertoireStrictLockError) throw error;
    throw failure('INVALID_LOCK');
  }
}

function deriveVersion(ref: string): string {
  const version = ref.startsWith('v') ? ref.slice(1) : ref;
  if (!SEMVER_PATTERN.test(version)) throw failure('INVALID_LOCK');
  if (ref !== version && ref !== `v${version}`) {
    throw failure('INVALID_LOCK');
  }
  return version;
}

export function parseProjectTemplateRepertoireStrictLock(
  value: unknown,
): ProjectTemplateRepertoireStrictLock {
  // Why: the legacy repertoire lock parser is intentionally permissive for
  // CLI listing. Inspection consumes only this bounded, non-coercing parser.
  const bytes = copyBoundedBytes(value);
  if (
    bytes.length >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) throw failure('INVALID_YAML');
  let text: string;
  try {
    text = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    throw failure('INVALID_ENCODING');
  }
  if (text.length === 0 || text.charCodeAt(0) === 0xfeff) {
    throw failure('INVALID_YAML');
  }
  let document;
  try {
    document = parseDocument(text, {
      customTags: [],
      merge: false,
      schema: 'core',
      uniqueKeys: true,
    });
  } catch {
    throw failure('INVALID_YAML');
  }
  if (document.errors.length !== 0 || document.warnings.length !== 0) {
    throw failure('INVALID_YAML');
  }
  rejectYamlFeatures(document.contents);
  const raw = requireExactMap(document.contents);
  if (
    !SOURCE_PATTERN.test(raw.source)
    || raw.source.length > 256
    || raw.ref.length > 128
    || !COMMIT_PATTERN.test(raw.commit)
  ) throw failure('INVALID_LOCK');
  const version = deriveVersion(raw.ref);
  requireCanonicalImportedAt(raw.imported_at);
  return freeze({
    source: raw.source as `github:${string}/${string}`,
    ref: raw.ref,
    version,
    commit: raw.commit,
    importedAt: raw.imported_at,
  }) as ProjectTemplateRepertoireStrictLock;
}
