import { createHash } from 'node:crypto';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireCapabilityV1,
  type ProjectTemplateRepertoireDependencyV1,
} from './source-descriptor.js';

const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_TYPE_ERROR = TypeError;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;

function canonicalString(value: string): string {
  const json = CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    CAPTURED_JSON_RECEIVER,
    [value],
  ) as string | undefined;
  if (json === undefined) {
    throw new CAPTURED_TYPE_ERROR('Invalid dependency string');
  }
  return json;
}

function canonicalCapabilities(
  capabilities: readonly ProjectTemplateRepertoireCapabilityV1[],
): string {
  return capabilities.length === 0 ? '[]' : '["edit"]';
}

function canonicalDependencies(
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
): string {
  let json = '[';
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index]!;
    if (index !== 0) json += ',';
    json += '{"scope":'
      + canonicalString(dependency.scope)
      + ',"version":'
      + canonicalString(dependency.version)
      + ',"source":'
      + canonicalString(dependency.source)
      + ',"commit":'
      + canonicalString(dependency.commit)
      + ',"capabilities":'
      + canonicalCapabilities(dependency.capabilities)
      + '}';
  }
  return `${json}]`;
}

function sha256(value: string): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [value, 'utf8']);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

/**
 * Calculates the sealed source-declaration identity used by G2 authority.
 *
 * Why: descriptor validation and authority issuance must share one canonical
 * byte contract. Keeping the bytes private prevents callers from treating an
 * intermediate serialization as a second, mutable sealing surface.
 */
export function calculateProjectTemplateRepertoireDependencyDeclarationSha256(
  dependencies: readonly ProjectTemplateRepertoireDependencyV1[],
): string {
  const strict = parseProjectTemplateRepertoireDependencies(
    dependencies,
    'request.dependencies',
  );
  return sha256(canonicalDependencies(strict));
}
