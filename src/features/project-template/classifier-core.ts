import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import type {
  ProjectTemplateClassification,
  ProjectTemplateClassificationReason,
  ProjectTemplateClassificationResult,
  ProjectTemplateClassifierInput,
} from './classifier-types.js';
import type { TemplateCapability, TemplateEntryPolicy } from './types.js';

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
  NODE_LIMIT_EXCEEDED: 'Node limit exceeded',
  FILE_LIMIT_EXCEEDED: 'File limit exceeded',
  SINGLE_FILE_LIMIT_EXCEEDED: 'Single-file byte limit exceeded',
  TOTAL_BYTES_LIMIT_EXCEEDED: 'Total byte limit exceeded',
  SCAN_LIMIT_EXCEEDED: 'Content scan byte limit exceeded',
  DEPTH_LIMIT_EXCEEDED: 'Directory depth limit exceeded',
  FILE_CHANGED_DURING_SCAN: 'File changed while it was scanned',
  FILE_READ_OVERFLOW: 'File grew beyond its inspected size while being read',
  READ_FAILED: 'File could not be read safely',
  ROOT_UNSAFE: 'Project root could not be inspected safely',
};

const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'=:])(?:\/(?:Users|Volumes|home|private|mnt)\/|[A-Za-z]:\\+(?:Users|Documents and Settings)\\+)/m;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/;

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function classifyPath(relativePath: string): {
  classification: ProjectTemplateClassification;
  reasonCode: ProjectTemplateClassificationReason;
  suggestedPolicy?: TemplateEntryPolicy;
} {
  const normalized = normalizeRelativePath(relativePath);
  const lower = normalized.toLocaleLowerCase('en-US');
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
      || /\bgh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(text)
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
    )
  ) {
    capabilities.push('external-command');
  }
  return capabilities;
}

function blocked(
  input: ProjectTemplateClassifierInput,
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
    detectedCapabilities: { path: relativePath, capabilities: [] },
    warnings: [],
  };
}

export function classifyProjectTemplateEntry(
  input: ProjectTemplateClassifierInput,
): ProjectTemplateClassificationResult {
  if (
    input.relativePath === ''
    || input.relativePath.includes('\\')
    || input.relativePath.includes('\0')
    || input.relativePath.startsWith('/')
    || /^[A-Za-z]:/.test(input.relativePath)
    || input.relativePath.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    // Never echo an attacker-controlled absolute/traversal path into a preview.
    return blocked(input, '[unsafe-path]', 'UNSAFE_ENTRY_PATH');
  }
  const relativePath = normalizeRelativePath(input.relativePath);
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
      bytes: input.bytes,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      detectedCapabilities: { path: relativePath, capabilities: [] },
      warnings: [],
    };
  }

  let text: string | undefined;
  if (input.content !== undefined) {
    if (input.content.includes(0)) {
      return blocked(input, relativePath, 'BINARY_CONTENT');
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input.content);
    } catch {
      return blocked(input, relativePath, 'BINARY_CONTENT');
    }
    if (PRIVATE_KEY_PATTERN.test(text) || sanitizeSensitiveText(text) !== text) {
      return blocked(input, relativePath, 'SECRET_CONTENT');
    }
    if (
      ABSOLUTE_PATH_PATTERN.test(text)
      || input.absolutePathPrefixes?.some((prefix) => prefix !== '' && text!.includes(prefix))
    ) {
      return blocked(input, relativePath, 'ABSOLUTE_PATH_CONTENT');
    }
  }

  return {
    relativePath,
    ...pathClassification,
    summary: SUMMARY_BY_REASON[pathClassification.reasonCode],
    bytes: input.bytes,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
    detectedCapabilities: {
      path: relativePath,
      capabilities: detectedCapabilities(relativePath, input.mode, text),
    },
    warnings: [],
  };
}

export function createProjectTemplateBlockedResult(
  relativePath: string,
  reasonCode: ProjectTemplateClassificationReason,
  bytes = 0,
): ProjectTemplateClassificationResult {
  return blocked({ relativePath, bytes }, normalizeRelativePath(relativePath), reasonCode);
}
