import { createHash } from 'node:crypto';
import { canonicalizeTaktpackJson } from './canonical-json.js';
import {
  assertAllowedKeys,
  parseSha256,
  requireRecord,
  requireSemVer,
} from './validation.js';

const DRAFT_ID_DOMAIN = 'takt.project-template.draft.v1\0';
const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;

export interface ProjectTemplateDraftIdentityInput {
  readonly parentArchiveSha256: string;
  readonly parentManifestSha256: string;
  readonly parentPackVersion: string;
  readonly editDocumentSha256: string;
}

function parseDraftIdentityInput(
  value: unknown,
): ProjectTemplateDraftIdentityInput {
  const input = requireRecord(value, 'draftIdentity');
  assertAllowedKeys(input, [
    'parentArchiveSha256',
    'parentManifestSha256',
    'parentPackVersion',
    'editDocumentSha256',
  ], 'draftIdentity');
  return {
    parentArchiveSha256: parseSha256(
      input['parentArchiveSha256'],
      'parentArchiveSha256',
    ),
    parentManifestSha256: parseSha256(
      input['parentManifestSha256'],
      'parentManifestSha256',
    ),
    parentPackVersion: requireSemVer(
      input['parentPackVersion'],
      'parentPackVersion',
    ),
    editDocumentSha256: parseSha256(
      input['editDocumentSha256'],
      'editDocumentSha256',
    ),
  };
}

/**
 * Binds an edit to the immutable pack it was derived from. The domain prefix
 * prevents a valid digest from another plan or archive contract from being
 * replayed as editor draft authority.
 */
export function calculateProjectTemplateDraftId(value: unknown): string {
  const input = parseDraftIdentityInput(value);
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [DRAFT_ID_DOMAIN, 'utf8']);
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [
    canonicalizeTaktpackJson({
      editDocumentSha256: input.editDocumentSha256,
      parentArchiveSha256: input.parentArchiveSha256,
      parentManifestSha256: input.parentManifestSha256,
      parentPackVersion: input.parentPackVersion,
    }),
    'utf8',
  ]);
  return CAPTURED_REFLECT_APPLY(CAPTURED_HASH_DIGEST, hash, ['hex']) as string;
}
