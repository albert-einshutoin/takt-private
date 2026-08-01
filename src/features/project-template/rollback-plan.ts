import { createHash } from 'node:crypto';
import { canonicalizeTaktpackJson } from './canonical-json.js';

const ROLLBACK_PLAN_DOMAIN = 'takt.project-template.rollback-plan.v1\u0000';
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface ProjectTemplateRollbackPlan {
  readonly schemaVersion: '1.0';
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly currentTargetSha256: string;
  readonly currentCompanionLocksSha256: string;
  readonly planId: string;
}

export interface CreateProjectTemplateRollbackPlanOptions {
  readonly backupId: string;
  readonly backupManifestSha256: string;
  readonly currentTargetSha256: string;
  readonly currentCompanionLocksSha256: string;
}

function requirePattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError('rollback plan witness is invalid');
  }
  return value;
}

/** Seals every read-only witness that must remain exact at rollback admission. */
export function createProjectTemplateRollbackPlan(
  options: CreateProjectTemplateRollbackPlanOptions,
): ProjectTemplateRollbackPlan {
  const backupId = requirePattern(options.backupId, SAFE_ID_PATTERN);
  const backupManifestSha256 = requirePattern(
    options.backupManifestSha256,
    SHA256_PATTERN,
  );
  const currentTargetSha256 = requirePattern(
    options.currentTargetSha256,
    SHA256_PATTERN,
  );
  const currentCompanionLocksSha256 = requirePattern(
    options.currentCompanionLocksSha256,
    SHA256_PATTERN,
  );
  const sealed = {
    schemaVersion: '1.0' as const,
    backupId,
    backupManifestSha256,
    currentTargetSha256,
    currentCompanionLocksSha256,
  };
  const planId = createHash('sha256').update(
    ROLLBACK_PLAN_DOMAIN + canonicalizeTaktpackJson(sealed),
    'utf8',
  ).digest('hex');
  return Object.freeze({ ...sealed, planId });
}
