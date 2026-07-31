import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  assertSealedProjectTemplateApplyPlan,
} from './apply-plan.js';
import type {
  ProjectTemplateApplyPlan,
  ProjectTemplateApplyPlanEntry,
} from './apply-plan-types.js';
import { ProjectTemplateValidationError } from './errors.js';
import {
  calculateProjectTemplateRepertoireDependencyPlanId,
  type ProjectTemplateRepertoireDependencyPlan,
} from './repertoire-dependency-plan.js';
import {
  renderProjectTemplateRepertoireDependencyPlanHuman,
  renderProjectTemplateRepertoireDependencyPlanJson,
} from './repertoire-dependency-preview.js';
import type {
  ProjectTemplateApplyPreview,
  ProjectTemplateApplyPreviewBindings,
  ProjectTemplateApplyPreviewCompositionConflictCode,
  ProjectTemplateApplyPreviewContentHardConflict,
  ProjectTemplateApplyPreviewOptions,
} from './apply-preview-types.js';

export type {
  ProjectTemplateApplyPreview,
  ProjectTemplateApplyPreviewBindings,
  ProjectTemplateApplyPreviewCompositionConflictCode,
  ProjectTemplateApplyPreviewContentHardConflict,
  ProjectTemplateApplyPreviewOptions,
} from './apply-preview-types.js';

type ReviewScalar = string | number | boolean | null;
type ReviewValue =
  | ReviewScalar
  | readonly ReviewValue[]
  | { readonly [key: string]: ReviewValue };

interface PreviewSeal {
  readonly previewId: string;
  readonly canonicalBody: string;
  readonly human: string;
  readonly json: string;
}

const PREVIEW_ID_DOMAIN = 'takt.project-template.apply-preview.v1\u0000';
const CAPTURED_OBJECT_RECEIVER = Object;
const CAPTURED_ARRAY_RECEIVER = Array;
const CAPTURED_JSON_RECEIVER = JSON;
const CAPTURED_REFLECT_RECEIVER = Reflect;
const CAPTURED_ARRAY_IS_ARRAY = Array.isArray;
const CAPTURED_ARRAY_JOIN = Array.prototype.join;
const CAPTURED_CREATE_HASH = createHash;
const CAPTURED_JSON_STRINGIFY = JSON.stringify;
const CAPTURED_OBJECT_CREATE = Object.create;
const CAPTURED_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const CAPTURED_OBJECT_FREEZE = Object.freeze;
const CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  Object.getOwnPropertyDescriptors;
const CAPTURED_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const CAPTURED_OBJECT_PROTOTYPE = Object.prototype;
const CAPTURED_REFLECT_APPLY = Reflect.apply;
const CAPTURED_REFLECT_OWN_KEYS = Reflect.ownKeys;
const CAPTURED_STRING = String;
const CAPTURED_TYPES_IS_PROXY = types.isProxy;
const CAPTURED_WEAK_MAP_GET = WeakMap.prototype.get;
const CAPTURED_WEAK_MAP_SET = WeakMap.prototype.set;
const HASH_SAMPLE = CAPTURED_CREATE_HASH('sha256');
const CAPTURED_HASH_UPDATE = HASH_SAMPLE.update;
const CAPTURED_HASH_DIGEST = HASH_SAMPLE.digest;

// Process-local membership prevents a serialized or structurally cloned review DTO
// from being promoted into an apply-authorizing value by downstream code.
const PREVIEW_SEALS = new WeakMap<object, PreviewSeal>();

function freeze<T>(value: T): Readonly<T> {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_FREEZE,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Readonly<T>;
}

function append<T>(values: T[], value: T): void {
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
    [values, CAPTURED_STRING(values.length), descriptor],
  );
}

function invalidPreview(field: string): never {
  throw new ProjectTemplateValidationError(
    'INVALID_LOCK',
    'apply preview requires an exact process-local sealed value',
    field,
  );
}

function snapshotOptions(value: unknown): {
  readonly contentPlan: unknown;
  readonly repertoireDependencyPlan: unknown;
} {
  if (
    typeof value !== 'object'
    || value === null
    || CAPTURED_REFLECT_APPLY(CAPTURED_TYPES_IS_PROXY, types, [value])
    || CAPTURED_REFLECT_APPLY(
      CAPTURED_OBJECT_GET_PROTOTYPE_OF,
      CAPTURED_OBJECT_RECEIVER,
      [value],
    ) !== CAPTURED_OBJECT_PROTOTYPE
  ) invalidPreview('applyPreview');
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [descriptors],
  ) as PropertyKey[];
  if (keys.length !== 2) invalidPreview('applyPreview');
  const content = descriptors['contentPlan'];
  const dependency = descriptors['repertoireDependencyPlan'];
  if (
    content === undefined
    || !('value' in content)
    || dependency === undefined
    || !('value' in dependency)
  ) invalidPreview('applyPreview');
  for (let index = 0; index < keys.length; index += 1) {
    if (
      keys[index] !== 'contentPlan'
      && keys[index] !== 'repertoireDependencyPlan'
    ) invalidPreview('applyPreview');
  }
  return freeze({
    contentPlan: content.value,
    repertoireDependencyPlan: dependency.value,
  });
}

function requireSealedDependencyPlan(
  value: unknown,
): ProjectTemplateRepertoireDependencyPlan {
  const calculated = calculateProjectTemplateRepertoireDependencyPlanId(
    value as ProjectTemplateRepertoireDependencyPlan,
  );
  const plan = value as ProjectTemplateRepertoireDependencyPlan;
  if (plan.planId !== calculated) invalidPreview('repertoireDependencyPlan.planId');
  return plan;
}

function canonicalString(value: string): string {
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_JSON_STRINGIFY,
    CAPTURED_JSON_RECEIVER,
    [value],
  ) as string;
}

function canonicalJson(value: ReviewValue): string {
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return CAPTURED_STRING(value);
  }
  if (value === null) return 'null';
  if (CAPTURED_REFLECT_APPLY(
    CAPTURED_ARRAY_IS_ARRAY,
    CAPTURED_ARRAY_RECEIVER,
    [value],
  )) {
    const array = value as readonly ReviewValue[];
    let json = '[';
    for (let index = 0; index < array.length; index += 1) {
      if (index !== 0) json += ',';
      json += canonicalJson(array[index]!);
    }
    return `${json}]`;
  }
  const descriptors = CAPTURED_REFLECT_APPLY(
    CAPTURED_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    CAPTURED_OBJECT_RECEIVER,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const keys = CAPTURED_REFLECT_APPLY(
    CAPTURED_REFLECT_OWN_KEYS,
    CAPTURED_REFLECT_RECEIVER,
    [descriptors],
  ) as PropertyKey[];
  let json = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]! as string;
    if (index !== 0) json += ',';
    json += canonicalString(key) + ':'
      + canonicalJson(descriptors[key]!.value as ReviewValue);
  }
  return `${json}}`;
}

function hashPreviewBody(canonicalBody: string): string {
  const hash = CAPTURED_CREATE_HASH('sha256');
  CAPTURED_REFLECT_APPLY(CAPTURED_HASH_UPDATE, hash, [
    PREVIEW_ID_DOMAIN + canonicalBody,
    'utf8',
  ]);
  return CAPTURED_REFLECT_APPLY(
    CAPTURED_HASH_DIGEST,
    hash,
    ['hex'],
  ) as string;
}

function contentReview(plan: ProjectTemplateApplyPlan): ReviewValue {
  return freeze({
    schemaVersion: plan.schemaVersion,
    planId: plan.planId,
    ...(plan.baseLockSha256 === undefined
      ? {}
      : { baseLockSha256: plan.baseLockSha256 }),
    incomingManifestSha256: plan.incomingManifestSha256,
    ...(plan.incomingArchiveSha256 === undefined
      ? {}
      : { incomingArchiveSha256: plan.incomingArchiveSha256 }),
    incomingCompatibility: plan.incomingCompatibility,
    capabilitiesBefore: plan.capabilitiesBefore,
    capabilitiesAfter: plan.capabilitiesAfter,
    ...(plan.basePackVersion === undefined
      ? {}
      : { basePackVersion: plan.basePackVersion }),
    incomingPackVersion: plan.incomingPackVersion,
    flags: freeze({
      reviewRequired: plan.reviewRequired,
      defaultApplyPossible: plan.defaultApplyPossible,
    }),
    entries: plan.entries as unknown as readonly ReviewValue[],
    summary: plan.summary as unknown as ReviewValue,
  }) as unknown as ReviewValue;
}

function contentHardConflicts(
  plan: ProjectTemplateApplyPlan,
): readonly ProjectTemplateApplyPreviewContentHardConflict[] {
  const conflicts: ProjectTemplateApplyPreviewContentHardConflict[] = [];
  if (plan.incomingCompatibility === 'incompatible') {
    append(conflicts, freeze({
      code: 'INCOMING_COMPATIBILITY_INCOMPATIBLE',
    }));
  }
  for (let index = 0; index < plan.entries.length; index += 1) {
    const entry = plan.entries[index]!;
    if (entry.action === 'conflict') {
      append(conflicts, freeze({
        code: 'CONTENT_ENTRY_CONFLICT',
        path: entry.path,
        reasonCode: entry.reasonCode,
      }));
    }
  }
  return freeze(conflicts);
}

function publicBindings(
  bindings: ProjectTemplateApplyPreviewBindings,
): ReviewValue {
  return freeze({
    contentPlanId: bindings.contentPlanId,
    repertoireDependencyPlanId: bindings.repertoireDependencyPlanId,
    incomingManifestSha256: bindings.incomingManifestSha256,
    ...(bindings.incomingArchiveSha256 === undefined
      ? {}
      : { incomingArchiveSha256: bindings.incomingArchiveSha256 }),
    ...(bindings.baseLockSha256 === undefined
      ? {}
      : { baseLockSha256: bindings.baseLockSha256 }),
    sourceDescriptorSha256: bindings.sourceDescriptorSha256,
    repertoireDeclarationSha256: bindings.repertoireDeclarationSha256,
    ...(bindings.previousRepertoireLockSha256 === undefined
      ? {}
      : {
        previousRepertoireLockSha256:
          bindings.previousRepertoireLockSha256,
      }),
  });
}

function humanPreview(
  previewId: string,
  bindings: ProjectTemplateApplyPreviewBindings,
  compositionConflicts:
    readonly ProjectTemplateApplyPreviewCompositionConflictCode[],
  hardConflicts:
    readonly ProjectTemplateApplyPreviewContentHardConflict[],
  dependencyHardConflict: boolean,
  reviewRequired: boolean,
  hardConflict: boolean,
  defaultApplyPossible: boolean,
  contentPlan: ProjectTemplateApplyPlan,
  dependencyHuman: string,
): string {
  const lines: string[] = [];
  append(lines, 'project-template-apply-preview schema=1.0');
  append(lines, `previewId=${previewId}`);
  append(lines, `contentPlanId=${bindings.contentPlanId}`);
  append(lines, `repertoireDependencyPlanId=${bindings.repertoireDependencyPlanId}`);
  append(lines, 'bindings:'
    + ` manifest=${bindings.incomingManifestSha256}`
    + ` sourceDescriptor=${bindings.sourceDescriptorSha256}`
    + ` declaration=${bindings.repertoireDeclarationSha256}`);
  append(lines, `compositionConflicts=${canonicalJson(compositionConflicts)}`);
  append(lines, `contentHardConflicts=${canonicalJson(hardConflicts as unknown as ReviewValue)}`);
  append(lines, `dependencyHardConflict=${dependencyHardConflict}`);
  append(lines, `flags: reviewRequired=${reviewRequired}`
    + ` hardConflict=${hardConflict}`
    + ` defaultApplyPossible=${defaultApplyPossible}`);
  append(lines, 'content:');
  append(lines, `  compatibility=${contentPlan.incomingCompatibility}`);
  append(lines, `  summary=${canonicalString(contentPlan.summary.human)}`);
  for (let index = 0; index < contentPlan.entries.length; index += 1) {
    const entry: ProjectTemplateApplyPlanEntry = contentPlan.entries[index]!;
    append(lines, `  - path=${canonicalString(entry.path)}`
      + ` policy=${entry.policy}`
      + ` action=${entry.action}`
      + ` reason=${entry.reasonCode}`
      + ` reviewRequired=${entry.reviewRequired}`);
    if (entry.mergeDiagnostics !== undefined) {
      append(lines, '    diagnostics='
        + canonicalJson(entry.mergeDiagnostics as unknown as ReviewValue));
    }
  }
  append(lines, 'repertoireDependencies:');
  append(lines, dependencyHuman);
  return CAPTURED_REFLECT_APPLY(CAPTURED_ARRAY_JOIN, lines, ['\n']) as string;
}

/** Composes content and repertoire review surfaces without granting apply authority. */
export function createProjectTemplateApplyPreview(
  value: ProjectTemplateApplyPreviewOptions,
): ProjectTemplateApplyPreview {
  const options = snapshotOptions(value);
  const contentPlan = assertSealedProjectTemplateApplyPlan(options.contentPlan);
  const dependencyPlan = requireSealedDependencyPlan(
    options.repertoireDependencyPlan,
  );
  const compositionConflicts:
    ProjectTemplateApplyPreviewCompositionConflictCode[] = [];
  if (contentPlan.incomingManifestSha256 !== dependencyPlan.manifestSha256) {
    append(compositionConflicts, 'MANIFEST_BINDING_MISMATCH');
  }
  freeze(compositionConflicts);
  const hardContent = contentHardConflicts(contentPlan);
  const dependencyHardConflict = dependencyPlan.hardConflict;
  const hardConflict = compositionConflicts.length !== 0
    || hardContent.length !== 0
    || dependencyHardConflict;
  const reviewRequired = hardConflict
    || contentPlan.reviewRequired
    || dependencyPlan.reviewRequired;
  const defaultApplyPossible = !reviewRequired && !hardConflict;
  const bindings = freeze({
    contentPlanId: contentPlan.planId,
    contentPreconditionToken: contentPlan.preconditionToken,
    repertoireDependencyPlanId: dependencyPlan.planId,
    repertoireDependencyPreconditionToken: dependencyPlan.preconditionToken,
    incomingManifestSha256: contentPlan.incomingManifestSha256,
    ...(contentPlan.incomingArchiveSha256 === undefined
      ? {}
      : { incomingArchiveSha256: contentPlan.incomingArchiveSha256 }),
    ...(contentPlan.baseLockSha256 === undefined
      ? {}
      : { baseLockSha256: contentPlan.baseLockSha256 }),
    sourceDescriptorSha256: dependencyPlan.sourceDescriptorSha256,
    repertoireDeclarationSha256: dependencyPlan.declarationSha256,
    ...(dependencyPlan.previousLockSha256 === undefined
      ? {}
      : {
        previousRepertoireLockSha256: dependencyPlan.previousLockSha256,
      }),
  });
  const contentDto = contentReview(contentPlan);
  const dependencyJson =
    renderProjectTemplateRepertoireDependencyPlanJson(dependencyPlan);
  // Opaque precondition tokens remain inside the hash input so the preview is
  // invalidated by either plan changing, while renderers expose only safe fields.
  const internalBody = freeze({
    schemaVersion: '1.0',
    bindings,
    compositionConflicts,
    contentHardConflicts: hardContent,
    dependencyHardConflict,
    reviewRequired,
    hardConflict,
    defaultApplyPossible,
    contentReview: contentDto,
    repertoireDependencyReviewJson: dependencyJson,
  }) as unknown as ReviewValue;
  const canonicalBody = canonicalJson(internalBody);
  const previewId = hashPreviewBody(canonicalBody);
  const preview = freeze({
    schemaVersion: '1.0' as const,
    previewId,
    bindings,
    compositionConflicts,
    contentHardConflicts: hardContent,
    dependencyHardConflict,
    reviewRequired,
    hardConflict,
    defaultApplyPossible,
  }) as ProjectTemplateApplyPreview;
  const json = '{"schemaVersion":"1.0","previewId":'
    + canonicalString(previewId)
    + ',"bindings":' + canonicalJson(publicBindings(bindings))
    + ',"compositionConflicts":' + canonicalJson(compositionConflicts)
    + ',"contentHardConflicts":'
    + canonicalJson(hardContent as unknown as ReviewValue)
    + ',"dependencyHardConflict":' + CAPTURED_STRING(dependencyHardConflict)
    + ',"flags":{"reviewRequired":' + CAPTURED_STRING(reviewRequired)
    + ',"hardConflict":' + CAPTURED_STRING(hardConflict)
    + ',"defaultApplyPossible":' + CAPTURED_STRING(defaultApplyPossible)
    + '},"content":' + canonicalJson(contentDto)
    + ',"repertoireDependencies":' + dependencyJson + '}';
  const human = humanPreview(
    previewId,
    bindings,
    compositionConflicts,
    hardContent,
    dependencyHardConflict,
    reviewRequired,
    hardConflict,
    defaultApplyPossible,
    contentPlan,
    renderProjectTemplateRepertoireDependencyPlanHuman(dependencyPlan),
  );
  CAPTURED_REFLECT_APPLY(CAPTURED_WEAK_MAP_SET, PREVIEW_SEALS, [
    preview,
    freeze({ previewId, canonicalBody, human, json }),
  ]);
  return preview;
}

/** Rejects clones and deserialized review DTOs without traversing them. */
export function assertProjectTemplateApplyPreview(
  value: unknown,
): ProjectTemplateApplyPreview {
  const seal = typeof value === 'object' && value !== null
    ? CAPTURED_REFLECT_APPLY(
      CAPTURED_WEAK_MAP_GET,
      PREVIEW_SEALS,
      [value],
    ) as PreviewSeal | undefined
    : undefined;
  if (seal === undefined) invalidPreview('applyPreview');
  const preview = value as ProjectTemplateApplyPreview;
  if (
    preview.previewId !== seal.previewId
    || hashPreviewBody(seal.canonicalBody) !== seal.previewId
  ) invalidPreview('applyPreview.previewId');
  return preview;
}

export function renderProjectTemplateApplyPreviewHuman(
  value: ProjectTemplateApplyPreview,
): string {
  const preview = assertProjectTemplateApplyPreview(value);
  const seal = CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    PREVIEW_SEALS,
    [preview],
  ) as PreviewSeal;
  return seal.human;
}

export function renderProjectTemplateApplyPreviewJson(
  value: ProjectTemplateApplyPreview,
): string {
  const preview = assertProjectTemplateApplyPreview(value);
  const seal = CAPTURED_REFLECT_APPLY(
    CAPTURED_WEAK_MAP_GET,
    PREVIEW_SEALS,
    [preview],
  ) as PreviewSeal;
  return seal.json;
}
