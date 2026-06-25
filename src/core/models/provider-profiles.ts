/**
 * Provider-specific permission profile types.
 */

import type { PermissionMode } from './status.js';

export const DEFAULT_PROVIDER_PROFILE_PERMISSION_MODE: PermissionMode = 'edit';

/** Supported providers for profile-based permission resolution. */
export const PROVIDER_PROFILE_NAMES = [
  'claude',
  'claude-sdk',
  'claude-terminal',
  'codex',
  'codex-cli',
  'opencode',
  'opencode-cli',
  'cursor',
  'cursor-cli',
  'copilot',
  'kiro',
  'agy-cli',
  'mock',
] as const;

export type ProviderProfileName = (typeof PROVIDER_PROFILE_NAMES)[number];

/** Permission profile for a single provider. */
export interface ProviderPermissionProfile {
  /** Default permission mode for steps that do not have an explicit override. */
  defaultPermissionMode: PermissionMode;
  /** Per-step permission overrides keyed by step name. */
  stepPermissionOverrides?: Record<string, PermissionMode>;
}

/** Provider -> permission profile map. */
export type ProviderPermissionProfiles = Partial<Record<ProviderProfileName, ProviderPermissionProfile>>;
