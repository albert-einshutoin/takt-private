import { PROVIDER_PROFILE_NAMES } from '../../core/models/provider-profiles.js';
import type { EnvSpec } from './env/config-env-shared.js';

const PROVIDER_PROFILES_ENV_SPEC_ENTRIES = [
  { path: 'provider_profiles', type: 'json' },
] as const satisfies readonly EnvSpec[];

const PROVIDER_PROFILES_STATIC_TRACE_PATHS = [
  'provider_profiles',
  ...PROVIDER_PROFILE_NAMES.flatMap((provider) => [
    `provider_profiles.${provider}`,
    `provider_profiles.${provider}.default_permission_mode`,
    `provider_profiles.${provider}.step_permission_overrides`,
  ]),
] as const;

export const PROVIDER_PROFILES_ENV_SPECS: readonly EnvSpec[] = PROVIDER_PROFILES_ENV_SPEC_ENTRIES;
export const PROVIDER_PROFILES_TRACKED_KEYS: readonly string[] = PROVIDER_PROFILES_STATIC_TRACE_PATHS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getProviderProfilesTrackedKeys(parsedConfig?: Record<string, unknown>): readonly string[] {
  if (!parsedConfig || !isRecord(parsedConfig.provider_profiles)) {
    return PROVIDER_PROFILES_TRACKED_KEYS;
  }

  const keys = new Set<string>(PROVIDER_PROFILES_TRACKED_KEYS);
  for (const provider of PROVIDER_PROFILE_NAMES) {
    const profile = parsedConfig.provider_profiles[provider];
    if (!isRecord(profile)) {
      continue;
    }
    keys.add(`provider_profiles.${provider}`);
    keys.add(`provider_profiles.${provider}.default_permission_mode`);
    keys.add(`provider_profiles.${provider}.step_permission_overrides`);

    const overrides = profile.step_permission_overrides;
    if (!isRecord(overrides)) {
      continue;
    }
    for (const stepName of Object.keys(overrides)) {
      // Step names are user-defined, so these leaf paths are generated from the parsed file.
      keys.add(`provider_profiles.${provider}.step_permission_overrides.${stepName}`);
    }
  }

  return [...keys];
}
