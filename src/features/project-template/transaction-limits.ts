import { MAX_PROJECT_TEMPLATE_COHORT_BYTES } from './archive-types.js';
import { DEFAULT_PROJECT_TEMPLATE_MAX_NODES } from './classifier-types.js';
import {
  MAX_TEMPLATE_ENTRIES,
  MAX_TEMPLATE_PATH_LENGTH,
} from './validation.js';

export const PROJECT_TEMPLATE_ENTRY_OPERATION_PREFIX = 'entry:';

const MAX_OPERATION_KEY_LENGTH =
  PROJECT_TEMPLATE_ENTRY_OPERATION_PREFIX.length + MAX_TEMPLATE_PATH_LENGTH;
const MAX_OPERATIONS = MAX_TEMPLATE_ENTRIES + 3;
const MAX_CREATED_TARGET_DIRECTORIES = DEFAULT_PROJECT_TEMPLATE_MAX_NODES + 1;
const SERIALIZED_CONTROL_FIXED_BYTES = 4 * 1024;
// Portable paths cannot contain JSON escape characters, while this fixed
// allowance conservatively covers both before/after witnesses and metadata.
const SERIALIZED_JSON_ITEM_OVERHEAD_BYTES = 1024;

/** Shared bounds for apply evidence, durable journals, and offline recovery. */
export const PROJECT_TEMPLATE_TRANSACTION_LIMITS = Object.freeze({
  maxBytes: MAX_PROJECT_TEMPLATE_COHORT_BYTES,
  maxOperations: MAX_OPERATIONS,
  maxCreatedTargetDirectories: MAX_CREATED_TARGET_DIRECTORIES,
  maxOperationKeyLength: MAX_OPERATION_KEY_LENGTH,
  maxManifestBytes: Math.min(
    MAX_PROJECT_TEMPLATE_COHORT_BYTES,
    SERIALIZED_CONTROL_FIXED_BYTES
      + MAX_OPERATIONS
        * (MAX_OPERATION_KEY_LENGTH * 2 + SERIALIZED_JSON_ITEM_OVERHEAD_BYTES)
      + MAX_CREATED_TARGET_DIRECTORIES
        * (MAX_TEMPLATE_PATH_LENGTH + 3),
  ),
  maxJournalBytes: Math.min(
    MAX_PROJECT_TEMPLATE_COHORT_BYTES,
    SERIALIZED_CONTROL_FIXED_BYTES
      // Reserve two full operation-key vectors so a future explicit publish
      // and rollback progress representation remains readable by this contract.
      + MAX_OPERATIONS * 2 * (MAX_OPERATION_KEY_LENGTH + 3)
      + MAX_CREATED_TARGET_DIRECTORIES
        * (MAX_TEMPLATE_PATH_LENGTH + 3),
  ),
});
