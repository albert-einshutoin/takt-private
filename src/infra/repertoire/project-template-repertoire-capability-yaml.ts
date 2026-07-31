import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { TextDecoder, types } from 'node:util';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
} from 'yaml';

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
const CAPTURED_IS_ALIAS = isAlias;
const CAPTURED_IS_MAP = isMap;
const CAPTURED_IS_SCALAR = isScalar;
const CAPTURED_IS_SEQ = isSeq;
const CAPTURED_CREATE_HASH = createHash;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_RECEIVER = Object;
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

function scalarString(node: Node | null): string | undefined {
  return node !== null
    && CAPTURED_IS_SCALAR(node)
    && typeof (node as Scalar).value === 'string'
    ? (node as Scalar).value as string
    : undefined;
}

function rejectUnsafeNode(
  node: Node | null,
  depth: number,
  budget: InspectionBudget,
): void {
  if (node === null) return;
  budget.nodes += 1;
  if (
    budget.nodes > MAX_CAPABILITY_YAML_NODES
    || depth > MAX_CAPABILITY_YAML_DEPTH
    || CAPTURED_IS_ALIAS(node)
    || typeof node.anchor === 'string'
    || (
      typeof node.tag === 'string'
      && CAPTURED_REFLECT_APPLY(
        CAPTURED_STRING_CHAR_CODE_AT,
        node.tag,
        [0],
      ) === 0x21
    )
  ) throw failure('INVALID_YAML');
  if (CAPTURED_IS_SCALAR(node)) return;
  if (CAPTURED_IS_SEQ(node)) {
    for (let index = 0; index < node.items.length; index += 1) {
      rejectUnsafeNode(node.items[index] as Node | null, depth + 1, budget);
    }
    return;
  }
  if (!CAPTURED_IS_MAP(node)) throw failure('INVALID_YAML');
  for (let index = 0; index < node.items.length; index += 1) {
    budget.nodes += 1;
    if (budget.nodes > MAX_CAPABILITY_YAML_NODES) {
      throw failure('INVALID_YAML');
    }
    const pair = node.items[index] as Pair<Node, Node>;
    const key = scalarString(pair.key);
    if (key === undefined || key === '<<') throw failure('INVALID_YAML');
    rejectUnsafeNode(pair.key, depth + 1, budget);
    rejectUnsafeNode(pair.value, depth + 1, budget);
  }
}

function requireMap(node: Node | null): YAMLMap {
  if (node === null || !CAPTURED_IS_MAP(node)) {
    throw failure('INVALID_CAPABILITY_YAML');
  }
  return node;
}

function requireSequenceOfMaps(node: Node | null): void {
  if (node === null || !CAPTURED_IS_SEQ(node)) {
    throw failure('INVALID_CAPABILITY_YAML');
  }
  for (let index = 0; index < node.items.length; index += 1) {
    requireMap(node.items[index] as Node | null);
  }
}

function validateWorkflowShape(node: Node | null): void {
  if (node === null || CAPTURED_IS_SCALAR(node)) return;
  if (CAPTURED_IS_SEQ(node)) {
    for (let index = 0; index < node.items.length; index += 1) {
      validateWorkflowShape(node.items[index] as Node | null);
    }
    return;
  }
  const mapping = requireMap(node);
  for (let index = 0; index < mapping.items.length; index += 1) {
    const pair = mapping.items[index] as Pair<Node, Node>;
    const key = scalarString(pair.key)!;
    const value = pair.value;
    if (key === 'edit') {
      if (
        value === null
        || !CAPTURED_IS_SCALAR(value)
        || typeof (value as Scalar).value !== 'boolean'
      ) throw failure('INVALID_CAPABILITY_YAML');
    } else if (key === 'required_permission_mode') {
      if (scalarString(value) === undefined) {
        throw failure('INVALID_CAPABILITY_YAML');
      }
    } else if (key === 'provider_options') {
      requireMap(value);
      continue;
    } else if (key === 'steps' || key === 'parallel' || key === 'promotion') {
      requireSequenceOfMaps(value);
    } else if (key === 'overrides') {
      requireMap(value);
    }
    validateWorkflowShape(value);
  }
}

function validateProviderOptionsShape(root: YAMLMap): void {
  for (let index = 0; index < root.items.length; index += 1) {
    const pair = root.items[index] as Pair<Node, Node>;
    if (scalarString(pair.key) !== 'extends') continue;
    const value = scalarString(pair.value);
    if (
      value === undefined
      || CAPTURED_REFLECT_APPLY(CAPTURED_STRING_TRIM, value, []) === ''
    ) throw failure('INVALID_CAPABILITY_YAML');
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
  let document: ReturnType<typeof parseDocument>;
  YAML_PARSE_ACTIVE = true;
  try {
    document = CAPTURED_PARSE_DOCUMENT(text, {
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
      keepSourceTokens: false,
    });
  } catch {
    throw failure('INVALID_YAML');
  } finally {
    YAML_PARSE_ACTIVE = false;
  }
  if (document.errors.length !== 0 || document.warnings.length !== 0) {
    throw failure('INVALID_YAML');
  }
  rejectUnsafeNode(document.contents as Node | null, 0, { nodes: 0 });
  const root = requireMap(document.contents as Node | null);
  if (kind === 'workflow') validateWorkflowShape(root);
  else validateProviderOptionsShape(root);
  return freeze({ text, sha256: digest }) as
    ProjectTemplateRepertoireCapabilityYaml;
}
