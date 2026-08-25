import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import { parseDocument } from 'yaml';

const MAX_CAPABILITY_YAML_BYTES = 1024 * 1024;
const MAX_CAPABILITY_YAML_NODES = 8192;
const MAX_CAPABILITY_YAML_DEPTH = 32;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: false,
});
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)!.get!;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)!.get!;
const CAPTURED_PARSE_DOCUMENT = parseDocument;
const CAPTURED_CREATE_HASH = createHash;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const CAPTURED_OBJECT_HAS_OWN = Object.hasOwn;
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const CAPTURED_BUFFER_ALLOC_UNSAFE_SLOW = Buffer.allocUnsafeSlow;
const CAPTURED_BUFFER_RECEIVER = Buffer;
const CAPTURED_TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const CAPTURED_STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const CAPTURED_STRING_TRIM = String.prototype.trim;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_TYPES_IS_SHARED_ARRAY_BUFFER = types.isSharedArrayBuffer;
const CAPTURED_TYPES_IS_UINT8_ARRAY = types.isUint8Array;
const CAPTURED_WEAK_SET_ADD = WeakSet.prototype.add;
const CAPTURED_WEAK_SET_HAS = WeakSet.prototype.has;
const CAPABILITY_YAML_ERRORS = new WeakSet<object>();
const YAML_NODE_TYPE = Symbol.for('yaml.node.type');
const YAML_ALIAS = Symbol.for('yaml.alias');
const YAML_MAP = Symbol.for('yaml.map');
const YAML_PAIR = Symbol.for('yaml.pair');
const YAML_SCALAR = Symbol.for('yaml.scalar');
const YAML_SEQ = Symbol.for('yaml.seq');
let YAML_PARSE_ACTIVE = false;

export type ProjectTemplateRepertoireCapabilityYamlKind =
  | 'workflow'
  | 'provider-options';

export type ProjectTemplateRepertoireCapabilityYamlErrorCode =
  | 'INVALID_ARGUMENT'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_ENCODING'
  | 'INVALID_YAML'
  | 'INVALID_CAPABILITY_YAML';

const ERROR_MESSAGES:
Record<ProjectTemplateRepertoireCapabilityYamlErrorCode, string> = {
  INVALID_ARGUMENT: 'Repertoire capability YAML input is invalid',
  LIMIT_EXCEEDED: 'Repertoire capability YAML byte limit was exceeded',
  INVALID_ENCODING: 'Repertoire capability YAML encoding is invalid',
  INVALID_YAML: 'Repertoire capability YAML is invalid',
  INVALID_CAPABILITY_YAML: 'Repertoire capability YAML shape is invalid',
};

export class ProjectTemplateRepertoireCapabilityYamlError extends Error {
  declare public readonly code:
    ProjectTemplateRepertoireCapabilityYamlErrorCode;

  constructor(code: ProjectTemplateRepertoireCapabilityYamlErrorCode) {
    const validated = validateErrorCode(code);
    super(errorMessage(validated));
    defineOwn(this, 'code', validated);
    defineOwn(this, 'name', 'ProjectTemplateRepertoireCapabilityYamlError');
    CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_ADD,
      CAPABILITY_YAML_ERRORS,
      [this],
    );
  }
}

export interface ProjectTemplateRepertoireCapabilityYaml {
  /** Private canonical input snapshot. Never expose through a public port. */
  readonly text: string;
  readonly sha256: string;
  /** Strictly validated extends requirements for controlled snapshot access. */
  readonly providerExtends: readonly string[];
}

function validateErrorCode(
  code: unknown,
): ProjectTemplateRepertoireCapabilityYamlErrorCode {
  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'LIMIT_EXCEEDED':
    case 'INVALID_ENCODING':
    case 'INVALID_YAML':
    case 'INVALID_CAPABILITY_YAML':
      return code;
    default:
      return 'INVALID_ARGUMENT';
  }
}

function errorMessage(
  code: ProjectTemplateRepertoireCapabilityYamlErrorCode,
): string {
  switch (code) {
    case 'INVALID_ARGUMENT': return ERROR_MESSAGES.INVALID_ARGUMENT;
    case 'LIMIT_EXCEEDED': return ERROR_MESSAGES.LIMIT_EXCEEDED;
    case 'INVALID_ENCODING': return ERROR_MESSAGES.INVALID_ENCODING;
    case 'INVALID_YAML': return ERROR_MESSAGES.INVALID_YAML;
    case 'INVALID_CAPABILITY_YAML':
      return ERROR_MESSAGES.INVALID_CAPABILITY_YAML;
    default: return ERROR_MESSAGES.INVALID_ARGUMENT;
  }
}

function failure(
  code: ProjectTemplateRepertoireCapabilityYamlErrorCode,
): ProjectTemplateRepertoireCapabilityYamlError {
  return new ProjectTemplateRepertoireCapabilityYamlError(code);
}

function isFailure(
  value: unknown,
): value is ProjectTemplateRepertoireCapabilityYamlError {
  return typeof value === 'object'
    && value !== null
    && CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_SET_HAS,
      CAPABILITY_YAML_ERRORS,
      [value],
    ) === true;
}

function defineOwn(target: object, key: PropertyKey, value: unknown): void {
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_CREATE,
    CAPTURED_OBJECT_RECEIVER,
    [null],
  ) as PropertyDescriptor;
  descriptor.configurable = true;
  descriptor.enumerable = true;
  descriptor.value = value;
  descriptor.writable = true;
  CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_DEFINE_PROPERTY,
    CAPTURED_OBJECT_RECEIVER,
    [target, key, descriptor],
  );
}

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function append<T>(values: T[], value: T): void {
  defineOwn(values, values.length, value);
}

function exactByteLength(value: unknown): number {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || !CAPTURED_TYPES_IS_UINT8_ARRAY(value)
  ) throw failure('INVALID_ARGUMENT');
  try {
    const buffer = CAPTURED_REFLECT_APPLY(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    );
    if (CAPTURED_TYPES_IS_SHARED_ARRAY_BUFFER(buffer)) {
      throw failure('INVALID_ARGUMENT');
    }
    return CAPTURED_REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch (error) {
    if (isFailure(error)) throw error;
    throw failure('INVALID_ARGUMENT');
  }
}

function copyBoundedBytes(value: unknown): Buffer {
  const byteLength = exactByteLength(value);
  if (byteLength > MAX_CAPABILITY_YAML_BYTES) {
    throw failure('LIMIT_EXCEEDED');
  }
  try {
    const snapshot = CAPTURED_REFLECT_APPLY(
      CAPTURED_BUFFER_ALLOC_UNSAFE_SLOW,
      CAPTURED_BUFFER_RECEIVER,
      [byteLength],
    ) as Buffer;
    const source = value as Uint8Array;
    // Why: integer-indexed copying avoids Buffer pool and mutable TypedArray
    // length surfaces while producing a callback-free private byte snapshot.
    for (let index = 0; index < byteLength; index += 1) {
      snapshot[index] = source[index]!;
    }
    return snapshot;
  } catch {
    throw failure('INVALID_ARGUMENT');
  }
}

function decodeText(bytes: Buffer): string {
  if (
    bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
  ) throw failure('INVALID_YAML');
  let text: string;
  try {
    text = CAPTURED_REFLECT_APPLY(
      CAPTURED_TEXT_DECODER_DECODE,
      FATAL_UTF8_DECODER,
      [bytes],
    ) as string;
  } catch {
    throw failure('INVALID_ENCODING');
  }
  if (text === '') throw failure('INVALID_YAML');
  for (let index = 0; index < text.length; index += 1) {
    const code = CAPTURED_REFLECT_APPLY(
      CAPTURED_STRING_CHAR_CODE_AT,
      text,
      [index],
    ) as number;
    if (
      code === 0xfeff
      || code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) throw failure('INVALID_YAML');
  }
  return text;
}

function sha256(value: Uint8Array): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [value]);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

interface InspectionBudget {
  nodes: number;
}

type YamlNodeKind = 'alias' | 'map' | 'pair' | 'scalar' | 'seq';

function ownData(target: unknown, key: PropertyKey, required: boolean): unknown {
  if (
    typeof target !== 'object'
    || target === null
    || CAPTURED_TYPES_IS_PROXY(target)
  ) throw failure('INVALID_YAML');
  const descriptor = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    CAPTURED_OBJECT_RECEIVER,
    [target, key],
  ) as PropertyDescriptor | undefined;
  if (descriptor === undefined) {
    if (required) throw failure('INVALID_YAML');
    return undefined;
  }
  if (!CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_HAS_OWN,
    CAPTURED_OBJECT_RECEIVER,
    [descriptor, 'value'],
  )) throw failure('INVALID_YAML');
  return descriptor.value;
}

function nodeKind(node: unknown): YamlNodeKind {
  const kind = ownData(node, YAML_NODE_TYPE, true);
  if (kind === YAML_ALIAS) return 'alias';
  if (kind === YAML_MAP) return 'map';
  if (kind === YAML_PAIR) return 'pair';
  if (kind === YAML_SCALAR) return 'scalar';
  if (kind === YAML_SEQ) return 'seq';
  throw failure('INVALID_YAML');
}

function arrayLength(value: unknown): number {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_TYPES_IS_PROXY(value)
    || !CAPTURED_ARRAY_IS_ARRAY(value)
  ) throw failure('INVALID_YAML');
  const length = ownData(value, 'length', true);
  if (!CAPTURED_NUMBER_IS_SAFE_INTEGER(length) || (length as number) < 0) {
    throw failure('INVALID_YAML');
  }
  return length as number;
}

function arrayItem(value: unknown, index: number): unknown {
  return ownData(value, index, true);
}

function scalarValue(node: unknown): unknown {
  if (nodeKind(node) !== 'scalar') throw failure('INVALID_CAPABILITY_YAML');
  return ownData(node, 'value', true);
}

function scalarString(node: unknown): string | undefined {
  if (node === null || nodeKind(node) !== 'scalar') return undefined;
  const value = ownData(node, 'value', true);
  return typeof value === 'string' ? value : undefined;
}

function rejectUnsafeNode(
  node: unknown,
  depth: number,
  budget: InspectionBudget,
): void {
  if (node === null) return;
  budget.nodes += 1;
  const kind = nodeKind(node);
  const anchor = ownData(node, 'anchor', false);
  const tag = ownData(node, 'tag', false);
  if (
    budget.nodes > MAX_CAPABILITY_YAML_NODES
    || depth > MAX_CAPABILITY_YAML_DEPTH
    || kind === 'alias'
    || (anchor !== undefined && anchor !== null)
    // Why: an own tag is how `yaml` records both standard (`!!str`) and
    // custom explicit tags; implicit nodes have no own `tag` property.
    || (tag !== undefined && tag !== null)
  ) throw failure('INVALID_YAML');
  if (kind === 'scalar') {
    ownData(node, 'value', true);
    return;
  }
  if (kind === 'seq') {
    const items = ownData(node, 'items', true);
    const length = arrayLength(items);
    for (let index = 0; index < length; index += 1) {
      rejectUnsafeNode(arrayItem(items, index), depth + 1, budget);
    }
    return;
  }
  if (kind !== 'map') throw failure('INVALID_YAML');
  const items = ownData(node, 'items', true);
  const length = arrayLength(items);
  for (let index = 0; index < length; index += 1) {
    budget.nodes += 1;
    if (budget.nodes > MAX_CAPABILITY_YAML_NODES) {
      throw failure('INVALID_YAML');
    }
    const pair = arrayItem(items, index);
    if (nodeKind(pair) !== 'pair') throw failure('INVALID_YAML');
    const pairKey = ownData(pair, 'key', true);
    const pairValue = ownData(pair, 'value', true);
    const key = scalarString(pairKey);
    if (key === undefined || key === '<<') throw failure('INVALID_YAML');
    rejectUnsafeNode(pairKey, depth + 1, budget);
    rejectUnsafeNode(pairValue, depth + 1, budget);
  }
}

function requireMap(node: unknown): object {
  if (node === null || nodeKind(node) !== 'map') {
    throw failure('INVALID_CAPABILITY_YAML');
  }
  return node as object;
}

function requireSequenceOfMaps(node: unknown): void {
  if (node === null || nodeKind(node) !== 'seq') {
    throw failure('INVALID_CAPABILITY_YAML');
  }
  const items = ownData(node, 'items', true);
  const length = arrayLength(items);
  for (let index = 0; index < length; index += 1) {
    requireMap(arrayItem(items, index));
  }
}

function validateWorkflowShape(node: unknown, providerExtends: string[]): void {
  if (node === null || nodeKind(node) === 'scalar') return;
  if (nodeKind(node) === 'seq') {
    const items = ownData(node, 'items', true);
    const length = arrayLength(items);
    for (let index = 0; index < length; index += 1) {
      validateWorkflowShape(arrayItem(items, index), providerExtends);
    }
    return;
  }
  const mapping = requireMap(node);
  const items = ownData(mapping, 'items', true);
  const length = arrayLength(items);
  for (let index = 0; index < length; index += 1) {
    const pair = arrayItem(items, index);
    if (nodeKind(pair) !== 'pair') throw failure('INVALID_YAML');
    const key = scalarString(ownData(pair, 'key', true));
    if (key === undefined) throw failure('INVALID_YAML');
    const value = ownData(pair, 'value', true);
    if (key === 'edit') {
      if (value === null || typeof scalarValue(value) !== 'boolean') {
        throw failure('INVALID_CAPABILITY_YAML');
      }
    } else if (key === 'required_permission_mode') {
      if (scalarString(value) === undefined) {
        throw failure('INVALID_CAPABILITY_YAML');
      }
    } else if (key === 'provider_options') {
      validateProviderOptionsShape(requireMap(value), providerExtends);
      continue;
    } else if (key === 'steps' || key === 'parallel' || key === 'promotion') {
      requireSequenceOfMaps(value);
    } else if (key === 'overrides') {
      requireMap(value);
    }
    validateWorkflowShape(value, providerExtends);
  }
}

function validateProviderOptionsShape(
  root: object,
  providerExtends: string[],
): void {
  const items = ownData(root, 'items', true);
  const length = arrayLength(items);
  for (let index = 0; index < length; index += 1) {
    const pair = arrayItem(items, index);
    if (nodeKind(pair) !== 'pair') throw failure('INVALID_YAML');
    if (scalarString(ownData(pair, 'key', true)) !== 'extends') continue;
    const value = scalarString(ownData(pair, 'value', true));
    if (
      value === undefined
      || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_TRIM, value, []) === ''
    ) throw failure('INVALID_CAPABILITY_YAML');
    append(providerExtends, value);
  }
}

/**
 * Parse bounded capability YAML at the private repertoire trust boundary.
 *
 * `yaml` is a trusted-library boundary: its parser uses mutable realm
 * prototypes and callbacks may observe parser-owned scalar/AST receivers.
 * The synchronous guard prevents nested authority work, while only the
 * pre-parser text/hash snapshot can escape. Removing that residual receiver
 * visibility requires an isolated-realm G3.3 security follow-up.
 */
export function parseProjectTemplateRepertoireCapabilityYaml(
  value: unknown,
  kind: ProjectTemplateRepertoireCapabilityYamlKind,
): ProjectTemplateRepertoireCapabilityYaml {
  if (YAML_PARSE_ACTIVE) throw failure('INVALID_YAML');
  if (kind !== 'workflow' && kind !== 'provider-options') {
    throw failure('INVALID_ARGUMENT');
  }
  const bytes = copyBoundedBytes(value);
  const text = decodeText(bytes);
  const digest = sha256(bytes);
  YAML_PARSE_ACTIVE = true;
  try {
    const document: unknown = CAPTURED_PARSE_DOCUMENT(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
      keepSourceTokens: false,
    });
    const errors = ownData(document, 'errors', true);
    const warnings = ownData(document, 'warnings', true);
    if (arrayLength(errors) !== 0 || arrayLength(warnings) !== 0) {
      throw failure('INVALID_YAML');
    }
    const contents = ownData(document, 'contents', true);
    rejectUnsafeNode(contents, 0, { nodes: 0 });
    const root = requireMap(contents);
    const providerExtends: string[] = [];
    if (kind === 'workflow') validateWorkflowShape(root, providerExtends);
    else validateProviderOptionsShape(root, providerExtends);
    return freeze({
      text,
      sha256: digest,
      providerExtends: freeze(providerExtends),
    }) as
      ProjectTemplateRepertoireCapabilityYaml;
  } catch (error) {
    if (isFailure(error)) throw error;
    // Why: parser and AST validation are an untrusted error boundary; raw
    // thrown values may contain source bytes or hostile getter secrets.
    throw failure('INVALID_YAML');
  } finally {
    YAML_PARSE_ACTIVE = false;
  }
}
