import * as path from 'node:path';
import { DEFAULT_COMMAND_GATE_TIMEOUT_MS } from './quality-gate-defaults.js';
import type { QualityGate } from './workflow-types.js';

function normalizeCommandGateCwd(cwd: string | undefined): string {
  if (cwd === undefined) return '.';
  const normalized = path.normalize(cwd);
  if (normalized === path.parse(normalized).root) return normalized;
  const withoutTrailingSeparator = normalized.endsWith(path.sep)
    ? normalized.slice(0, -1)
    : normalized;
  return withoutTrailingSeparator.length > 0 ? withoutTrailingSeparator : '.';
}

/**
 * Produces the runtime deduplication identity for a validated quality gate.
 * Keeping this identity shared prevents template merge from retaining a gate
 * that runtime would later treat as the same command under default values.
 */
export function qualityGateDedupeKey(gate: QualityGate): string {
  if (typeof gate === 'string') return `string:${JSON.stringify(gate)}`;
  return `command:${JSON.stringify([
    gate.type,
    gate.name ?? null,
    gate.command,
    normalizeCommandGateCwd(gate.cwd),
    gate.timeoutMs ?? DEFAULT_COMMAND_GATE_TIMEOUT_MS,
  ])}`;
}

/**
 * Reads the raw snake_case representation used in project YAML and maps it to
 * the same identity as the normalized runtime model.
 */
export function rawQualityGateDedupeKey(value: unknown): string | undefined {
  if (typeof value === 'string') return qualityGateDedupeKey(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const gate = value as Record<string, unknown>;
  if (
    gate['type'] !== 'command'
    || typeof gate['command'] !== 'string'
    || (gate['name'] !== undefined && typeof gate['name'] !== 'string')
    || (gate['cwd'] !== undefined && typeof gate['cwd'] !== 'string')
  ) {
    return undefined;
  }
  const timeout = gate['timeout_ms'] ?? gate['timeoutMs'];
  if (timeout !== undefined && typeof timeout !== 'number') return undefined;
  return qualityGateDedupeKey({
    type: 'command',
    command: gate['command'],
    ...(typeof gate['name'] === 'string' ? { name: gate['name'] } : {}),
    ...(typeof gate['cwd'] === 'string' ? { cwd: gate['cwd'] } : {}),
    ...(typeof timeout === 'number' ? { timeoutMs: timeout } : {}),
  });
}
