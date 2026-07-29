import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import type {
  ProjectTemplateClassification,
  ProjectTemplateClassificationReason,
  ProjectTemplateClassificationResult,
  ProjectTemplateClassifierInput,
} from './classifier-types.js';
import type { TemplateCapability, TemplateEntryPolicy } from './types.js';
import {
  parsePortablePath,
  parsePosixMode,
  parseSha256,
  requireArray,
} from './validation.js';

const MAX_CLASSIFIER_CONTENT_BYTES = 1024 * 1024;
const MAX_ABSOLUTE_PATH_PREFIXES = 8;
const MAX_ABSOLUTE_PATH_PREFIX_LENGTH = 1024;
const MAX_ABSOLUTE_PATH_PREFIX_TOTAL = 4096;

const RUNTIME_ROOTS = new Set([
  '.devloop',
  'runs',
  'tmp',
  'worktrees',
  'tasks',
  'completed',
  'logs',
  'session',
  'persona',
  'staged',
  'cache',
]);

const SUMMARY_BY_REASON: Record<ProjectTemplateClassificationReason, string> = {
  PROJECT_CONFIG: 'Project-owned configuration requires review',
  SHARED_WORKFLOW: 'Shared workflow candidate',
  SHARED_FACET: 'Shared facet candidate',
  SHARED_PROVIDER_OPTIONS: 'Shared provider options candidate',
  PROJECT_AUTOMATION: 'Project-owned automation requires review',
  PROJECT_QUALITY_GATE: 'Project-owned quality gate',
  UNKNOWN_DEFAULT_DENY: 'Unknown path is excluded by default',
  RUNTIME_STATE: 'Runtime state is excluded',
  SENSITIVE_FILENAME: 'Sensitive filename is blocked',
  SECRET_CONTENT: 'Sensitive content is blocked',
  ABSOLUTE_PATH_CONTENT: 'Machine-specific absolute path is blocked',
  BINARY_CONTENT: 'Binary content is blocked',
  ROOT_SYMLINK: 'Symbolic-link root is blocked',
  SYMLINK: 'Symbolic link is blocked',
  HARD_LINK: 'Hard-linked file is blocked',
  UNSUPPORTED_FILE_TYPE: 'Unsupported file type is blocked',
  PATH_ESCAPE: 'Path outside the project root is blocked',
  PATH_COLLISION: 'Portable path collision is blocked',
  UNSAFE_ENTRY_PATH: 'Unsafe entry path is blocked',
  INVALID_CLASSIFIER_INPUT: 'Classifier input is invalid',
  NODE_LIMIT_EXCEEDED: 'Node limit exceeded',
  FILE_LIMIT_EXCEEDED: 'File limit exceeded',
  SINGLE_FILE_LIMIT_EXCEEDED: 'Single-file byte limit exceeded',
  TOTAL_BYTES_LIMIT_EXCEEDED: 'Total byte limit exceeded',
  SCAN_LIMIT_EXCEEDED: 'Content scan byte limit exceeded',
  DEPTH_LIMIT_EXCEEDED: 'Directory depth limit exceeded',
  FILE_CHANGED_DURING_SCAN: 'File changed while it was scanned',
  DIRECTORY_CHANGED_DURING_SCAN: 'Directory changed while it was scanned',
  FILE_READ_OVERFLOW: 'File grew beyond its inspected size while being read',
  READ_FAILED: 'File could not be read safely',
  ROOT_UNSAFE: 'Project root could not be inspected safely',
};

const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'=:])(?:~\/|\/(?!\/)[A-Za-z0-9._-]+(?:\/[^\s"'=:]+)*|[A-Za-z]:[\\/]+|\\\\[^\\\s]+\\[^\\\s]+)/m;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;

function classifyPath(relativePath: string): {
  classification: ProjectTemplateClassification;
  reasonCode: ProjectTemplateClassificationReason;
  suggestedPolicy?: TemplateEntryPolicy;
} {
  const lower = relativePath.toLocaleLowerCase('en-US');
  const segments = lower.split('/');
  const basename = segments.at(-1) ?? '';

  if (
    basename === '.env'
    || basename.startsWith('.env.')
    || /(?:secret|credential|private[-_.]?key|id_rsa|id_ed25519)/i.test(basename)
  ) {
    return { classification: 'blocked', reasonCode: 'SENSITIVE_FILENAME' };
  }
  if (
    RUNTIME_ROOTS.has(segments[0] ?? '')
    || (segments[0] === 'quality-gates' && segments[1] === 'logs')
  ) {
    return { classification: 'excluded', reasonCode: 'RUNTIME_STATE' };
  }
  if (lower === 'config.yaml' || lower === 'devloopd.yaml') {
    return {
      classification: 'project-owned',
      reasonCode: 'PROJECT_CONFIG',
      suggestedPolicy: 'merge',
    };
  }
  if (
    segments[0] === 'workflows'
    && segments.length > 1
    && (basename.endsWith('.yaml') || basename.endsWith('.yml'))
  ) {
    return {
      classification: 'portable-candidate',
      reasonCode: 'SHARED_WORKFLOW',
      suggestedPolicy: 'merge',
    };
  }
  if (segments[0] === 'facets' && segments.length > 1 && basename.endsWith('.md')) {
    return {
      classification: 'portable-candidate',
      reasonCode: 'SHARED_FACET',
      suggestedPolicy: 'merge',
    };
  }
  if (
    segments[0] === 'provider-options'
    && segments.length > 1
    && (basename.endsWith('.yaml') || basename.endsWith('.yml'))
  ) {
    return {
      classification: 'portable-candidate',
      reasonCode: 'SHARED_PROVIDER_OPTIONS',
      suggestedPolicy: 'merge',
    };
  }
  if (segments[0] === 'automation' && segments.length > 1) {
    return {
      classification: 'project-owned',
      reasonCode: 'PROJECT_AUTOMATION',
      suggestedPolicy: 'scaffold',
    };
  }
  if (segments[0] === 'quality-gates' && segments.length > 1) {
    return { classification: 'project-owned', reasonCode: 'PROJECT_QUALITY_GATE' };
  }
  // Unknown paths never become portable merely because their contents look
  // harmless; a later explicit manifest/review may opt them in.
  return { classification: 'excluded', reasonCode: 'UNKNOWN_DEFAULT_DENY' };
}

function hasSensitivePathSegment(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => {
    const lower = segment.toLocaleLowerCase('en-US');
    return lower.startsWith('.env')
      || /(?:api[-_.]?key|access[-_.]?key|token|secret|credential|private[-_.]?key|id_rsa|id_ed25519)/i.test(segment)
      || sanitizeSensitiveText(segment) !== segment;
  });
}

function detectedCapabilities(
  relativePath: string,
  mode: string | undefined,
  text: string | undefined,
): TemplateCapability[] {
  const capabilities: TemplateCapability[] = [];
  if (mode !== undefined && (Number.parseInt(mode, 8) & 0o111) !== 0) {
    capabilities.push('executable');
  }
  if (
    text !== undefined
    && (
      /\bgh\s+(?:pr|issue)\s+(?:create|edit|close|merge|reopen)\b/i.test(text)
      || /\bgh\s+release\s+(?:create|delete|edit|upload)\b/i.test(text)
      || /\bgh\s+workflow\s+run\b/i.test(text)
      || /\bgh\s+secret\s+(?:set|delete)\b/i.test(text)
      || /\bgh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(text)
      || /\bgh\s+api\b[^\n]*--input(?:=|\s+)/i.test(text)
      || (
        /\bcurl\b[^\n]*https:\/\/api\.github\.com\b/i.test(text)
        && /(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:-d|--data(?:-raw|-binary|-urlencode)?)\s+/i.test(text)
      )
      || /\bgit\s+push\b/i.test(text)
    )
  ) {
    capabilities.push('github-write');
  }
  if (
    text !== undefined
    && (
      relativePath.startsWith('automation/')
      || /^#!\s*\//.test(text)
      || /\b(?:npm|pnpm|yarn|bun|make|cargo|go|swift|python|ruby|bash|sh|gh|git)\s+/m.test(text)
      || /^\s*(?:run|command|script)\s*:\s*\S+/m.test(text)
      || /\bcurl\s+/m.test(text)
    )
  ) {
    capabilities.push('external-command');
  }
  return capabilities;
}

function blocked(
  input: Pick<ProjectTemplateClassifierInput, 'bytes' | 'mode' | 'sha256'>,
  relativePath: string,
  reasonCode: ProjectTemplateClassificationReason,
): ProjectTemplateClassificationResult {
  return {
    relativePath,
    classification: 'blocked',
    reasonCode,
    summary: SUMMARY_BY_REASON[reasonCode],
    bytes: input.bytes,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
    detectedCapabilities: {
      path: relativePath,
      capabilities: [],
      inspectionStatus: 'blocked',
    },
    reviewRequired: true,
    warnings: [],
  };
}

function invalidClassifierInput(): ProjectTemplateClassificationResult {
  return blocked({ bytes: 0 }, '[invalid-input]', 'INVALID_CLASSIFIER_INPUT');
}

function parseClassifierInput(
  value: ProjectTemplateClassifierInput,
): ProjectTemplateClassifierInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return undefined;
  const allowed = new Set([
    'relativePath',
    'content',
    'absolutePathPrefixes',
    'bytes',
    'mode',
    'sha256',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    typeof value.relativePath !== 'string'
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || (value.content !== undefined && !(value.content instanceof Uint8Array))
    || (value.content !== undefined && value.content.byteLength > MAX_CLASSIFIER_CONTENT_BYTES)
    || (value.content !== undefined && value.content.byteLength !== value.bytes)
  ) {
    return undefined;
  }
  try {
    if (value.mode !== undefined) parsePosixMode(value.mode, 'classifier.mode');
    if (value.sha256 !== undefined) parseSha256(value.sha256, 'classifier.sha256');
  } catch {
    return undefined;
  }
  if (value.absolutePathPrefixes !== undefined) {
    let prefixes: unknown[];
    try {
      prefixes = requireArray(
        value.absolutePathPrefixes,
        'classifier.absolutePathPrefixes',
        MAX_ABSOLUTE_PATH_PREFIXES,
        'LIMIT_EXCEEDED',
      );
    } catch {
      return undefined;
    }
    if (prefixes.some(
      (prefix) => typeof prefix !== 'string' || prefix.length > MAX_ABSOLUTE_PATH_PREFIX_LENGTH,
    )) {
      return undefined;
    }
    const totalLength = prefixes.reduce<number>(
      (total, prefix) => total + (prefix as string).length,
      0,
    );
    if (totalLength > MAX_ABSOLUTE_PATH_PREFIX_TOTAL) return undefined;
  }
  return value;
}

export function classifyProjectTemplateEntry(
  input: ProjectTemplateClassifierInput,
): ProjectTemplateClassificationResult {
  let parsedInput: ProjectTemplateClassifierInput | undefined;
  try {
    parsedInput = parseClassifierInput(input);
  } catch {
    return invalidClassifierInput();
  }
  if (parsedInput === undefined) return invalidClassifierInput();
  let relativePath: string;
  try {
    // This is intentionally the same validator used by manifest and lock v1.
    relativePath = parsePortablePath(parsedInput.relativePath, 'classifier.relativePath');
  } catch {
    return blocked(parsedInput, '[unsafe-path]', 'UNSAFE_ENTRY_PATH');
  }
  if (hasSensitivePathSegment(relativePath)) {
    return blocked(parsedInput, '[sensitive-path]', 'SENSITIVE_FILENAME');
  }
  const pathClassification = classifyPath(relativePath);

  // Runtime and sensitive paths are decided from metadata so filesystem adapters
  // can avoid opening data that must never be inspected.
  if (
    pathClassification.classification === 'excluded'
    || pathClassification.classification === 'blocked'
  ) {
    return {
      relativePath,
      ...pathClassification,
      summary: SUMMARY_BY_REASON[pathClassification.reasonCode],
      bytes: parsedInput.bytes,
      ...(parsedInput.mode === undefined ? {} : { mode: parsedInput.mode }),
      ...(parsedInput.sha256 === undefined ? {} : { sha256: parsedInput.sha256 }),
      detectedCapabilities: {
        path: relativePath,
        capabilities: [],
        inspectionStatus: 'incomplete',
      },
      reviewRequired: false,
      warnings: [],
    };
  }

  let text: string | undefined;
  if (parsedInput.content !== undefined) {
    if (parsedInput.content.includes(0)) {
      return blocked(parsedInput, relativePath, 'BINARY_CONTENT');
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(parsedInput.content);
    } catch {
      return blocked(parsedInput, relativePath, 'BINARY_CONTENT');
    }
    if (PRIVATE_KEY_PATTERN.test(text) || sanitizeSensitiveText(text) !== text) {
      return blocked(parsedInput, relativePath, 'SECRET_CONTENT');
    }
    if (
      ABSOLUTE_PATH_PATTERN.test(text)
      || parsedInput.absolutePathPrefixes?.some((prefix) => prefix !== '' && text!.includes(prefix))
    ) {
      return blocked(parsedInput, relativePath, 'ABSOLUTE_PATH_CONTENT');
    }
  }

  const capabilities = detectedCapabilities(relativePath, parsedInput.mode, text);
  const reviewRequired = pathClassification.classification === 'project-owned'
    || capabilities.length > 0;
  return {
    relativePath,
    ...pathClassification,
    summary: SUMMARY_BY_REASON[pathClassification.reasonCode],
    bytes: parsedInput.bytes,
    ...(parsedInput.mode === undefined ? {} : { mode: parsedInput.mode }),
    ...(parsedInput.sha256 === undefined ? {} : { sha256: parsedInput.sha256 }),
    detectedCapabilities: {
      path: relativePath,
      capabilities,
      inspectionStatus: text === undefined ? 'incomplete' : 'complete',
    },
    reviewRequired,
    warnings: capabilities.includes('external-command')
      ? ['External command capability requires review']
      : [],
  };
}

export function createProjectTemplateBlockedResult(
  relativePath: string,
  reasonCode: ProjectTemplateClassificationReason,
  bytes = 0,
): ProjectTemplateClassificationResult {
  return blocked({ bytes }, relativePath, reasonCode);
}
