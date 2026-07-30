import { isDeepStrictEqual } from 'node:util';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  parseDocument,
  type Document,
  type Node,
  type Pair,
} from 'yaml';
import {
  resolveProjectTemplateConfigMergeRule,
  type ProjectTemplateConfigDocument,
} from './config-merge-rules.js';
import { rawQualityGateDedupeKey } from '../../core/models/quality-gate-identity.js';

export interface ProjectTemplateYamlMergeDiagnostic {
  readonly code:
    | 'MIXED_EOL'
    | 'UNKNOWN_SEQUENCE_ATOMIC'
    | 'RULE_REVIEW_REQUIRED'
    | 'GLOBAL_ONLY_IGNORED';
  readonly path: readonly string[];
  readonly message: string;
}

export interface ProjectTemplateYamlMergeConflict {
  readonly path: readonly string[];
  readonly reason: 'BOTH_CHANGED';
}

export type ProjectTemplateYamlMergeBlockedCode =
  | 'INVALID_YAML'
  | 'MULTI_DOCUMENT'
  | 'YAML_DIRECTIVE'
  | 'ALIAS_OR_ANCHOR'
  | 'MERGE_KEY'
  | 'CUSTOM_TAG'
  | 'NON_STRING_KEY'
  | 'FORBIDDEN_PATH'
  | 'MIXED_EOL_UNSUPPORTED';

export type ProjectTemplateYamlMergeResult =
  | {
    readonly status: 'merged';
    readonly content: Buffer;
    readonly changed: boolean;
    readonly reviewRequired: boolean;
    readonly diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[];
  }
  | {
    readonly status: 'conflict';
    readonly conflicts: readonly ProjectTemplateYamlMergeConflict[];
    readonly reviewRequired: true;
    readonly diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[];
  }
  | {
    readonly status: 'blocked';
    readonly code: ProjectTemplateYamlMergeBlockedCode;
    readonly document: 'base' | 'local' | 'incoming';
    readonly reviewRequired: true;
    readonly diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[];
  };

export interface MergeProjectTemplateYamlDocumentOptions {
  readonly document: ProjectTemplateConfigDocument;
  readonly base: Uint8Array;
  readonly local: Uint8Array;
  readonly incoming: Uint8Array;
}

const MISSING = Symbol('missing');
type SemanticValue =
  | null
  | boolean
  | number
  | string
  | SemanticValue[]
  | { readonly [key: string]: SemanticValue };
type MaybeValue = SemanticValue | typeof MISSING;

interface ParsedYamlDocument {
  readonly document: Document;
  readonly value: SemanticValue;
}

function textOf(value: Uint8Array): string {
  return Buffer.from(value).toString('utf8');
}

function blocked(
  code: ProjectTemplateYamlMergeBlockedCode,
  document: 'base' | 'local' | 'incoming',
  diagnostics: readonly ProjectTemplateYamlMergeDiagnostic[] = [],
): ProjectTemplateYamlMergeResult {
  return {
    status: 'blocked',
    code,
    document,
    reviewRequired: true,
    diagnostics,
  };
}

function unsafeNodeCode(node: Node | null): ProjectTemplateYamlMergeBlockedCode | undefined {
  if (node === null) return undefined;
  if (isAlias(node) || ('anchor' in node && typeof node.anchor === 'string')) {
    return 'ALIAS_OR_ANCHOR';
  }
  if ('tag' in node && typeof node.tag === 'string' && node.tag.startsWith('!')) {
    return 'CUSTOM_TAG';
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      const code = unsafeNodeCode(item as Node | null);
      if (code !== undefined) return code;
    }
  }
  if (isMap(node)) {
    for (const item of node.items as Array<Pair<Node, Node>>) {
      if (!isScalar(item.key) || typeof item.key.value !== 'string') {
        return 'NON_STRING_KEY';
      }
      if (item.key.value === '<<') return 'MERGE_KEY';
      const keyCode = unsafeNodeCode(item.key);
      if (keyCode !== undefined) return keyCode;
      const valueCode = unsafeNodeCode(item.value);
      if (valueCode !== undefined) return valueCode;
    }
  }
  return undefined;
}

function isSemanticValue(value: unknown): value is SemanticValue {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isSemanticValue);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value as Record<string, unknown>).every(isSemanticValue);
}

function parseSafeDocument(
  bytes: Uint8Array,
  source: 'base' | 'local' | 'incoming',
): ParsedYamlDocument | ProjectTemplateYamlMergeResult {
  const text = textOf(bytes);
  if (/^(?:\uFEFF)?%(?:YAML|TAG)\b/m.test(text)) {
    return blocked('YAML_DIRECTIVE', source);
  }
  const documents = parseAllDocuments(text, {
    strict: true,
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  if (documents.length !== 1) return blocked('MULTI_DOCUMENT', source);
  const document = parseDocument(text, {
    strict: true,
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  const unsafe = unsafeNodeCode(document.contents as Node | null);
  if (unsafe !== undefined) return blocked(unsafe, source);
  if (document.errors.length > 0 || document.warnings.length > 0) {
    return blocked('INVALID_YAML', source);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return blocked('INVALID_YAML', source);
  }
  if (!isSemanticValue(value)) return blocked('INVALID_YAML', source);
  return { document, value };
}

function isMapping(value: MaybeValue): value is Record<string, SemanticValue> {
  return value !== MISSING
    && value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function equal(left: MaybeValue, right: MaybeValue): boolean {
  return left === MISSING || right === MISSING
    ? left === right
    : isDeepStrictEqual(left, right);
}

function valueAt(value: MaybeValue, key: string): MaybeValue {
  return isMapping(value) && Object.hasOwn(value, key) ? value[key]! : MISSING;
}

function containsForbiddenPath(
  document: ProjectTemplateConfigDocument,
  value: SemanticValue,
  path: readonly string[] = [],
): boolean {
  if (isMapping(value)) {
    return Object.entries(value).some(([key, child]) => (
      containsForbiddenPath(document, child, [...path, key])
    ));
  }
  if (Array.isArray(value)) {
    return value.some((child) => containsForbiddenPath(document, child, path));
  }
  return resolveProjectTemplateConfigMergeRule(document, path).ownership === 'forbidden';
}

function canonicalSequenceIdentity(value: SemanticValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSequenceIdentity).join(',')}]`;
  }
  if (isMapping(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalSequenceIdentity(value[key]!)}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mergeOrderedSequence(
  local: readonly SemanticValue[],
  incoming: readonly SemanticValue[],
  identity: (value: SemanticValue) => string = canonicalSequenceIdentity,
): SemanticValue[] {
  const merged = [...local];
  const seen = new Set(local.map(identity));
  for (const item of incoming) {
    const key = identity(item);
    if (!seen.has(key)) {
      merged.push(item);
      seen.add(key);
    }
  }
  return merged;
}

function copyLocalNodePresentation(previous: unknown, replacement: unknown): void {
  if (
    previous === null
    || replacement === null
    || typeof previous !== 'object'
    || typeof replacement !== 'object'
  ) {
    return;
  }
  const before = previous as {
    comment?: string;
    commentBefore?: string;
    spaceBefore?: boolean;
  };
  const after = replacement as {
    comment?: string;
    commentBefore?: string;
    spaceBefore?: boolean;
  };
  if (before.comment !== undefined) after.comment = before.comment;
  if (before.commentBefore !== undefined) after.commentBefore = before.commentBefore;
  if (before.spaceBefore !== undefined) after.spaceBefore = before.spaceBefore;
}

function setDocumentValue(
  document: Document,
  path: readonly string[],
  value: MaybeValue,
): void {
  if (value === MISSING) {
    document.deleteIn(path);
    return;
  }
  const previous = document.getIn(path, true);
  const replacement = document.createNode(value);
  copyLocalNodePresentation(previous, replacement);
  document.setIn(path, replacement);
}

function setDocumentSequenceValue(
  document: Document,
  path: readonly string[],
  local: readonly SemanticValue[],
  merged: readonly SemanticValue[],
): void {
  const previous = document.getIn(path, true);
  if (!isSeq(previous)) {
    setDocumentValue(document, path, [...merged]);
    return;
  }
  const used = new Set<number>();
  previous.items = merged.map((value) => {
    const localIndex = local.findIndex(
      (candidate, index) => !used.has(index) && isDeepStrictEqual(candidate, value),
    );
    if (localIndex >= 0) {
      used.add(localIndex);
      // Reusing the existing node retains item comments, scalar style, and
      // blank-line presentation for every local value that survives the merge.
      return previous.items[localIndex]!;
    }
    return document.createNode(value);
  });
}

function eolDiagnostics(text: string): ProjectTemplateYamlMergeDiagnostic[] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > 0 && lf > 0
    ? [{
      code: 'MIXED_EOL',
      path: [],
      message: 'Local YAML contains mixed line endings and requires review',
    }]
    : [];
}

function restoreLocalTextEnvelope(localText: string, rendered: string): string {
  const hasBom = localText.startsWith('\uFEFF');
  const body = hasBom && rendered.startsWith('\uFEFF') ? rendered.slice(1) : rendered;
  const crlf = (localText.match(/\r\n/g) ?? []).length;
  const loneLf = (localText.match(/(?<!\r)\n/g) ?? []).length;
  const converted = crlf > 0 && loneLf === 0 ? body.replace(/\r?\n/g, '\r\n') : body;
  const hadFinalNewline = /(?:\r\n|\n)$/.test(localText);
  const normalizedFinal = hadFinalNewline
    ? converted.replace(/(?:\r\n|\n)*$/, crlf > 0 && loneLf === 0 ? '\r\n' : '\n')
    : converted.replace(/(?:\r\n|\n)+$/, '');
  return `${hasBom ? '\uFEFF' : ''}${normalizedFinal}`;
}

export function mergeProjectTemplateYamlDocument(
  options: MergeProjectTemplateYamlDocumentOptions,
): ProjectTemplateYamlMergeResult {
  const parsedBase = parseSafeDocument(options.base, 'base');
  if ('status' in parsedBase) return parsedBase;
  const parsedLocal = parseSafeDocument(options.local, 'local');
  if ('status' in parsedLocal) return parsedLocal;
  const parsedIncoming = parseSafeDocument(options.incoming, 'incoming');
  if ('status' in parsedIncoming) return parsedIncoming;
  if (containsForbiddenPath(options.document, parsedIncoming.value)) {
    return blocked('FORBIDDEN_PATH', 'incoming');
  }

  const diagnostics = eolDiagnostics(textOf(options.local));
  const conflicts: ProjectTemplateYamlMergeConflict[] = [];
  let semanticChanged = false;
  let forbiddenPath = false;

  const mergeAt = (
    path: readonly string[],
    base: MaybeValue,
    local: MaybeValue,
    incoming: MaybeValue,
  ): void => {
    if (equal(incoming, base) || equal(local, incoming)) return;
    if (isMapping(base) || isMapping(local) || isMapping(incoming)) {
      if (
        (base === MISSING || isMapping(base))
        && (local === MISSING || isMapping(local))
        && (incoming === MISSING || isMapping(incoming))
      ) {
        const keys = new Set([
          ...(isMapping(base) ? Object.keys(base) : []),
          ...(isMapping(local) ? Object.keys(local) : []),
          ...(isMapping(incoming) ? Object.keys(incoming) : []),
        ]);
        for (const key of keys) {
          mergeAt(
            [...path, key],
            valueAt(base, key),
            valueAt(local, key),
            valueAt(incoming, key),
          );
        }
        return;
      }
    }
    const rule = resolveProjectTemplateConfigMergeRule(options.document, path);
    if (rule.reviewRequired) {
      diagnostics.push({
        code: 'RULE_REVIEW_REQUIRED',
        path,
        message: 'Merge rule requires explicit review',
      });
    }
    if (rule.ownership === 'forbidden') {
      forbiddenPath = true;
      return;
    }
    if (rule.ownership === 'global-only') {
      diagnostics.push({
        code: 'GLOBAL_ONLY_IGNORED',
        path,
        message: 'Incoming global-only value was ignored',
      });
      return;
    }
    if (Array.isArray(local) && Array.isArray(incoming)) {
      if (rule.sequencePolicy === 'monotonic-set') {
        const merged = mergeOrderedSequence(
          local,
          [...(Array.isArray(base) ? base : []), ...incoming],
        );
        if (!isDeepStrictEqual(local, merged)) {
          setDocumentSequenceValue(parsedLocal.document, path, local, merged);
          semanticChanged = true;
        }
        return;
      }
      if (rule.sequencePolicy === 'ordered-keyed') {
        const identity = rule.sequenceIdentity === 'quality-gate'
          ? (value: SemanticValue) => (
              rawQualityGateDedupeKey(value)
              ?? canonicalSequenceIdentity(value)
            )
          : canonicalSequenceIdentity;
        const merged = mergeOrderedSequence(local, incoming, identity);
        if (!isDeepStrictEqual(local, merged)) {
          setDocumentSequenceValue(parsedLocal.document, path, local, merged);
          semanticChanged = true;
        }
        return;
      }
      if (rule.sequencePolicy === 'unordered-set' && Array.isArray(base)) {
        const additions = [...local, ...incoming].filter(
          (item) => !base.some((candidate) => isDeepStrictEqual(candidate, item)),
        );
        const retained = base.filter((item) => (
          local.some((candidate) => isDeepStrictEqual(candidate, item))
          && incoming.some((candidate) => isDeepStrictEqual(candidate, item))
        ));
        const merged = [...retained];
        for (const item of additions) {
          if (!merged.some((candidate) => isDeepStrictEqual(candidate, item))) {
            merged.push(item);
          }
        }
        if (!isDeepStrictEqual(local, merged)) {
          setDocumentSequenceValue(parsedLocal.document, path, local, merged);
          semanticChanged = true;
        }
        return;
      }
    }
    if (equal(local, base)) {
      if (Array.isArray(local) && Array.isArray(incoming)) {
        setDocumentSequenceValue(parsedLocal.document, path, local, incoming);
      } else {
        setDocumentValue(parsedLocal.document, path, incoming);
      }
      semanticChanged = true;
      return;
    }
    if (
      (Array.isArray(base) || Array.isArray(local) || Array.isArray(incoming))
      && !rule.known
    ) {
      diagnostics.push({
        code: 'UNKNOWN_SEQUENCE_ATOMIC',
        path,
        message: 'Unregistered sequence was merged atomically',
      });
    }
    conflicts.push({ path, reason: 'BOTH_CHANGED' });
  };

  mergeAt([], parsedBase.value, parsedLocal.value, parsedIncoming.value);
  if (forbiddenPath) return blocked('FORBIDDEN_PATH', 'incoming', diagnostics);
  if (conflicts.length > 0) {
    return {
      status: 'conflict',
      conflicts,
      reviewRequired: true,
      diagnostics,
    };
  }
  if (!semanticChanged) {
    return {
      status: 'merged',
      content: Buffer.from(options.local),
      changed: false,
      reviewRequired: diagnostics.length > 0,
      diagnostics,
    };
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === 'MIXED_EOL')) {
    return blocked('MIXED_EOL_UNSUPPORTED', 'local', diagnostics);
  }
  const rendered = restoreLocalTextEnvelope(
    textOf(options.local),
    parsedLocal.document.toString(),
  );
  return {
    status: 'merged',
    content: Buffer.from(rendered),
    changed: true,
    reviewRequired: diagnostics.length > 0,
    diagnostics,
  };
}
