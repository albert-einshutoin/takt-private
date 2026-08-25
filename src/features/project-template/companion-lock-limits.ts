import { MAX_PROJECT_TEMPLATE_COHORT_BYTES } from './archive-types.js';
import {
  MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES,
} from './repertoire-dependency-lock.js';
import { MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES } from './source-provenance.js';

export const MAX_PROJECT_TEMPLATE_CONTENT_LOCK_BYTES = 4 * 1024 * 1024;

function safeAddLimits(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new Error('project template transaction byte limits overflow');
    }
  }
  return total;
}

export const MAX_PROJECT_TEMPLATE_TRANSACTION_RECOVERY_BYTES = safeAddLimits(
  MAX_PROJECT_TEMPLATE_COHORT_BYTES,
  MAX_PROJECT_TEMPLATE_CONTENT_LOCK_BYTES,
  MAX_PROJECT_TEMPLATE_REPERTOIRE_DEPENDENCY_LOCK_BYTES,
  MAX_PROJECT_TEMPLATE_SOURCE_PROVENANCE_BYTES,
);
