/**
 * GitHub ref resolver for repertoire add command.
 *
 * Resolves the ref for a GitHub package installation.
 * When the spec omits @{ref}, queries the GitHub API for the default branch.
 */

/** Injectable function for calling `gh api` (enables unit testing without network). */
export type GhExecFn = (args: string[]) => string;

import { types } from 'node:util';
import {
  calculateProjectTemplateRepertoireDependencyDeclarationSha256,
} from '../project-template/repertoire-dependency-canonical.js';
import {
  parseProjectTemplateRepertoireDependencies,
  type ProjectTemplateRepertoireDependencyV1,
} from '../project-template/source-descriptor.js';
import {
  parseProjectTemplateGithubSourceSpec,
} from '../project-template/github-source-spec.js';

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CAPTURED_REFLECT_APPLY = Reflect.apply;

export interface GithubDependencyRefResolverPort {
  resolveRefToCommit(input: Readonly<{
    owner: string;
    repo: string;
    ref: string;
  }>): Promise<unknown>;
}

export interface VerifiedGithubDependencySourceEvidence {
  readonly method: 'github-ref-to-commit-v1';
  readonly declarationSha256: string;
  readonly count: number;
}

export type GithubDependencySourceVerificationErrorCode =
  | 'INVALID_ARGUMENT'
  | 'RESOLUTION_FAILED'
  | 'COMMIT_MISMATCH'
  | 'ABORTED';

export class GithubDependencySourceVerificationError extends Error {
  constructor(public readonly code: GithubDependencySourceVerificationErrorCode) {
    super('GitHub dependency source verification failed');
    this.name = 'GithubDependencySourceVerificationError';
  }
}

function verificationError(
  code: GithubDependencySourceVerificationErrorCode,
): never {
  throw Object.freeze(new GithubDependencySourceVerificationError(code));
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try {
    return signal.aborted;
  } catch {
    verificationError('INVALID_ARGUMENT');
  }
}

function parseResolvedCommit(value: unknown): string {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) verificationError('RESOLUTION_FAILED');
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'commit');
  if (
    keys.length !== 1
    || keys[0] !== 'commit'
    || descriptor === undefined
    || !('value' in descriptor)
    || typeof descriptor.value !== 'string'
    || !COMMIT_PATTERN.test(descriptor.value)
  ) verificationError('RESOLUTION_FAILED');
  return descriptor.value;
}

/**
 * Resolves every canonical dependency tag to an immutable commit in sequence.
 *
 * Why sequential: the authenticated metadata facade deliberately permits only
 * one in-flight operation and owns one short-lived credential. Parallel work
 * would either violate that lease or force a second credential surface.
 */
export async function verifyImmutableGithubDependencySources(options: {
  readonly dependencies: readonly ProjectTemplateRepertoireDependencyV1[];
  readonly resolver: GithubDependencyRefResolverPort;
  readonly signal?: AbortSignal;
}): Promise<VerifiedGithubDependencySourceEvidence> {
  let dependencies: ProjectTemplateRepertoireDependencyV1[];
  let receiver: GithubDependencyRefResolverPort;
  let resolveRefToCommit: GithubDependencyRefResolverPort['resolveRefToCommit'];
  let signal: AbortSignal | undefined;
  try {
    if (
      typeof options !== 'object'
      || options === null
      || types.isProxy(options)
      || Object.getPrototypeOf(options) !== Object.prototype
    ) verificationError('INVALID_ARGUMENT');
    const optionKeys = Reflect.ownKeys(options);
    if (
      !optionKeys.includes('dependencies')
      || !optionKeys.includes('resolver')
      || optionKeys.some((key) =>
        typeof key !== 'string'
        || !['dependencies', 'resolver', 'signal'].includes(key))
    ) verificationError('INVALID_ARGUMENT');
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (
      descriptors['dependencies'] === undefined
      || !('value' in descriptors['dependencies'])
      || descriptors['resolver'] === undefined
      || !('value' in descriptors['resolver'])
      || (
        descriptors['signal'] !== undefined
        && !('value' in descriptors['signal'])
      )
    ) verificationError('INVALID_ARGUMENT');
    dependencies = parseProjectTemplateRepertoireDependencies(
      descriptors['dependencies'].value,
      'request.dependencies',
    );
    receiver = descriptors['resolver'].value as GithubDependencyRefResolverPort;
    if (
      typeof receiver !== 'object'
      || receiver === null
      || types.isProxy(receiver)
    ) verificationError('INVALID_ARGUMENT');
    const method = Object.getOwnPropertyDescriptor(
      receiver,
      'resolveRefToCommit',
    );
    if (
      method === undefined
      || !('value' in method)
      || typeof method.value !== 'function'
      || types.isProxy(method.value)
    ) verificationError('INVALID_ARGUMENT');
    resolveRefToCommit = method.value as
      GithubDependencyRefResolverPort['resolveRefToCommit'];
    signal = descriptors['signal']?.value as AbortSignal | undefined;
    if (
      signal !== undefined
      && (
        typeof signal !== 'object'
        || signal === null
        || types.isProxy(signal)
        || Object.getPrototypeOf(signal) !== AbortSignal.prototype
      )
    ) verificationError('INVALID_ARGUMENT');
  } catch (error) {
    if (error instanceof GithubDependencySourceVerificationError) throw error;
    verificationError('INVALID_ARGUMENT');
  }

  if (signalAborted(signal)) verificationError('ABORTED');
  for (const dependency of dependencies) {
    const source = parseProjectTemplateGithubSourceSpec(dependency.source);
    if (source.kind !== 'github-ref') verificationError('INVALID_ARGUMENT');
    let resolution: unknown;
    try {
      resolution = await CAPTURED_REFLECT_APPLY(
        resolveRefToCommit,
        receiver,
        [Object.freeze({
          owner: source.owner,
          repo: source.repo,
          ref: source.ref,
        })],
      );
    } catch {
      if (signalAborted(signal)) verificationError('ABORTED');
      verificationError('RESOLUTION_FAILED');
    }
    if (signalAborted(signal)) verificationError('ABORTED');
    if (parseResolvedCommit(resolution) !== dependency.commit) {
      verificationError('COMMIT_MISMATCH');
    }
  }
  return Object.freeze({
    method: 'github-ref-to-commit-v1',
    declarationSha256:
      calculateProjectTemplateRepertoireDependencyDeclarationSha256(
        dependencies,
      ),
    count: dependencies.length,
  });
}

/**
 * Resolve the ref to use for a GitHub package installation.
 *
 * If specRef is provided, returns it directly. Otherwise calls the GitHub API
 * via execGh to retrieve the repository's default branch.
 *
 * @throws if the API call returns an empty branch name
 */
export function resolveRef(
  specRef: string | undefined,
  owner: string,
  repo: string,
  execGh: GhExecFn,
): string {
  if (specRef !== undefined) {
    return specRef;
  }

  const defaultBranch = execGh([
    'api',
    `/repos/${owner}/${repo}`,
    '--jq', '.default_branch',
  ]).trim();

  if (!defaultBranch) {
    throw new Error(`デフォルトブランチを取得できませんでした: ${owner}/${repo}`);
  }

  return defaultBranch;
}
